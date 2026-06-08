import fs from "fs";
import helpers from "../helpers.js";

/**
 * Finds the course's "Videos" navigation tab (an external-tool launch, typically
 * Panopto) and returns its absolute URL, or null if there isn't one.
 * @param {Page} page a page loaded on a course page (its left nav is present)
 * @param {string} label the nav label to look for (default "Videos")
 */
async function findVideosTabUrl(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => (s || "").trim().toLowerCase();
    const links = Array.from(document.querySelectorAll("#section-tabs a"));
    const isTool = (a) => /\/external_tools\//.test(a.getAttribute("href") || a.href);
    // Prefer an exact label match, then any nav tab mentioning "video".
    let match = links.find((a) => norm(a.textContent) === norm(label) && isTool(a));
    if (!match) match = links.find((a) => norm(a.textContent).includes("video") && isTool(a));
    return match ? match.href : null;
  }, label);
}

/**
 * Scrapes the course's "Videos" (Panopto) page: launches the Panopto LTI tab,
 * locates the Panopto folder it lands on, and downloads every session in it as
 * mp4 via yt-dlp (folders are treated as playlists). Best-effort — the exact
 * Panopto landing URL varies by institution.
 */
async function scrapeVideos(browser, cookies, url, dir) {
  console.log("=== SCRAPING VIDEOS ===");
  const videosDir = `${dir}/VIDEOS`;
  fs.mkdirSync(videosDir);

  const label =
    (JSON.parse(process.env.config || "{}").videosTabLabel) || "Videos";

  // 1. Load the course page and find the "Videos" nav tab.
  const page = await helpers.newPage(browser, cookies, url);
  if (page.status !== 200) {
    helpers.print("ERROR", "VIDEOS", "Could not load course page. Skipping...", 0);
    await page.close().catch(() => {});
    return;
  }

  let tabUrl = null;
  try {
    tabUrl = await findVideosTabUrl(page, label);
  } catch (e) {
    // fall through
  }
  await page.close().catch(() => {});

  if (!tabUrl) {
    helpers.print(
      "WARNING",
      "VIDEOS",
      `No "${label}" tab found in the course navigation. Skipping...`,
      0
    );
    return;
  }

  // 2. Launch the tab; the Panopto LTI loads (often in an iframe).
  const toolPage = await helpers.newPage(browser, cookies, tabUrl);
  await toolPage
    .waitForNetworkIdle({ idleTime: 1500, timeout: 20000 })
    .catch(() => {});

  // 3. Locate the Panopto URL among the page's frames (or the page itself).
  let panoptoUrl = null;
  for (const frame of toolPage.frames()) {
    const u = frame.url();
    if (/panopto\.com/i.test(u) && !/\/LTI\//i.test(u)) {
      panoptoUrl = u;
      break;
    }
  }
  // Fall back to any panopto frame, even the launch endpoint.
  if (!panoptoUrl) {
    for (const frame of toolPage.frames()) {
      if (/panopto\.com/i.test(frame.url())) {
        panoptoUrl = frame.url();
        break;
      }
    }
  }

  if (!panoptoUrl) {
    helpers.print(
      "WARNING",
      "VIDEOS",
      "Could not locate the Panopto folder for the Videos tab. Skipping...",
      0
    );
    await toolPage.close().catch(() => {});
    return;
  }

  // 4. Normalize to a folder URL yt-dlp understands, then download the folder.
  const folderUrl = helpers.panoptoFolderUrl(panoptoUrl) || panoptoUrl;
  helpers.print("NOTE", "VIDEOS", `Downloading Panopto folder: ${folderUrl}`, 0);

  let ok = false;
  try {
    ok = await helpers.downloadVideo(folderUrl, videosDir, cookies);
  } catch (e) {
    helpers.print("ERROR", "VIDEOS", "Could not download Panopto folder", 0, e);
  }

  if (!ok) {
    helpers.print(
      "WARNING",
      "VIDEOS",
      `Could not download the Videos folder. Open it manually: ${folderUrl}`,
      0
    );
  }

  await toolPage.close().catch(() => {});
  console.log("=== DONE SCRAPING VIDEOS ===");
}

export default scrapeVideos;
