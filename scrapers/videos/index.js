import fs from "fs";
import helpers from "../helpers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if the URL's hostname is panopto.com or a subdomain (not a substring match). */
function isPanoptoHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "panopto.com" || h.endsWith(".panopto.com");
  } catch (e) {
    return false;
  }
}

/** True if the URL is the Panopto LTI landing endpoint (…/Panopto/LTI/…), not a content page. */
function isLtiLanding(u) {
  try {
    return /\/Panopto\/LTI\//i.test(new URL(u).pathname);
  } catch (e) {
    return false;
  }
}

/**
 * Finds the course's "Videos" navigation tab (an external-tool launch, typically
 * Panopto) and returns its absolute URL, or null if there isn't one.
 */
async function findVideosTabUrl(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => (s || "").trim().toLowerCase();
    const links = Array.from(document.querySelectorAll("#section-tabs a"));
    const isTool = (a) => /\/external_tools\//.test(a.getAttribute("href") || a.href);
    let match = links.find((a) => norm(a.textContent) === norm(label) && isTool(a));
    if (!match) match = links.find((a) => norm(a.textContent).includes("video") && isTool(a));
    return match ? match.href : null;
  }, label);
}

/**
 * Waits for a frame that is actually hosted on Panopto (the LTI launch redirects
 * through a Canvas OIDC page whose URL merely *contains* the Panopto redirect_uri
 * — that must not be matched). Prefers a content page over the LTI landing.
 * @returns {Promise<import('puppeteer').Frame|null>}
 */
async function waitForPanoptoFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let fallback = null;
  while (Date.now() < deadline) {
    const frames = page.frames().filter((f) => isPanoptoHost(f.url()));
    const content = frames.find((f) => !isLtiLanding(f.url()));
    if (content) return content;
    if (frames.length) fallback = frames[0];
    await sleep(1000);
  }
  return fallback;
}

/** Reads the Panopto folder id and any session links from inside the Panopto frame. */
async function readFolderInfo(frame) {
  return frame.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]")).map((a) => a.href);
    const sessions = [
      ...new Set(
        anchors.filter((h) => /\/Pages\/(Viewer|Embed)\.aspx\?id=/i.test(h))
      ),
    ];
    let folderId = null;
    for (const h of [location.href, ...anchors]) {
      let s = h;
      try {
        s = decodeURIComponent(h);
      } catch (e) {
        /* keep raw */
      }
      const m = s.match(/folder(?:ID)?=?["'\s]{0,2}([0-9a-fA-F-]{36})/i);
      if (m) {
        folderId = m[1];
        break;
      }
    }
    return { href: location.href, folderId, sessions };
  });
}

/**
 * Scrapes the course's "Videos" (Panopto) page: launches the Panopto LTI tab,
 * resolves the Panopto folder it lands on, and downloads every session as mp4 via
 * yt-dlp (folders are treated as playlists). Best-effort and never throws.
 */
async function scrapeVideos(browser, cookies, url, dir) {
  console.log("=== SCRAPING VIDEOS ===");
  const videosDir = `${dir}/VIDEOS`;

  let coursePage;
  let toolPage;
  try {
    fs.mkdirSync(videosDir, { recursive: true });

    const label =
      JSON.parse(process.env.config || "{}").videosTabLabel || "Videos";

    // 1. Load the course page and find the "Videos" nav tab.
    coursePage = await helpers.newPage(browser, cookies, url);
    if (coursePage.status !== 200) {
      helpers.print("ERROR", "VIDEOS", "Could not load course page. Skipping...", 0);
      return;
    }
    const tabUrl = await findVideosTabUrl(coursePage, label).catch(() => null);
    if (!tabUrl) {
      helpers.print(
        "WARNING",
        "VIDEOS",
        `No "${label}" tab found in the course navigation. Skipping...`,
        0
      );
      return;
    }

    // 2. Launch the tab. The Panopto LTI page long-polls and never fires "load",
    //    so navigate tolerantly and don't wait for full load.
    toolPage = await browser.newPage();
    if (cookies && cookies.length) await toolPage.setCookie(...cookies);
    await toolPage
      .goto(tabUrl, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});

    // 3. Wait for a real Panopto-hosted frame (skipping the Canvas OIDC redirect).
    const frame = await waitForPanoptoFrame(toolPage, 30000);
    if (!frame) {
      helpers.print(
        "WARNING",
        "VIDEOS",
        "Could not reach the Panopto folder for the Videos tab. Skipping...",
        0
      );
      return;
    }

    // 4. Wait for the folder content (id or session links) to populate.
    let info = { href: frame.url(), folderId: null, sessions: [] };
    const evalDeadline = Date.now() + 12000;
    while (Date.now() < evalDeadline) {
      try {
        info = await readFolderInfo(frame);
      } catch (e) {
        /* frame may be mid-navigation; retry */
      }
      if (info.folderId || (info.sessions && info.sessions.length)) break;
      await sleep(1500);
    }

    let origin = null;
    try {
      origin = new URL(info.href || frame.url()).origin;
    } catch (e) {
      /* leave null */
    }

    let folderUrl = null;
    if (info.folderId && origin) {
      folderUrl = `${origin}/Panopto/Pages/Sessions/List.aspx?folderID=${info.folderId}`;
    }
    if (!folderUrl) folderUrl = helpers.panoptoFolderUrl(info.href || frame.url());

    // 5. Download the folder (preferred) or the individual sessions we found.
    if (folderUrl) {
      helpers.print("NOTE", "VIDEOS", `Downloading Panopto folder: ${folderUrl}`, 0);
      const ok = await helpers
        .downloadVideo(folderUrl, videosDir, cookies)
        .catch(() => false);
      if (!ok) {
        helpers.print(
          "WARNING",
          "VIDEOS",
          `Could not download the Videos folder. Open it manually: ${folderUrl}`,
          0
        );
      }
    } else if (info.sessions && info.sessions.length) {
      helpers.print(
        "NOTE",
        "VIDEOS",
        `Downloading ${info.sessions.length} Panopto session(s)...`,
        0
      );
      for (const s of info.sessions) {
        const ok = await helpers
          .downloadVideo(s, videosDir, cookies)
          .catch(() => false);
        if (!ok) helpers.print("WARNING", "VIDEOS", `Could not download ${s}`, 1);
      }
    } else {
      helpers.print(
        "WARNING",
        "VIDEOS",
        `Could not find the Panopto folder or sessions. Open it manually: ${
          info.href || frame.url()
        }`,
        0
      );
    }
  } catch (e) {
    helpers.print("ERROR", "VIDEOS", "Could not scrape the Videos page", 0, e);
  } finally {
    if (coursePage) await coursePage.close().catch(() => {});
    if (toolPage) await toolPage.close().catch(() => {});
    console.log("=== DONE SCRAPING VIDEOS ===");
  }
}

export default scrapeVideos;
