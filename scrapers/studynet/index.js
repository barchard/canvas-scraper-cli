import fs from "fs";
import helpers from "../helpers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if the URL's hostname is study.net or a subdomain of it. */
function isStudyNetHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "study.net" || h.endsWith(".study.net");
  } catch (e) {
    return false;
  }
}

/**
 * Finds the course's "Study.Net Materials" navigation tab (a signed LTI
 * external-tool launch) and returns its absolute URL, or null if there isn't one.
 */
async function findStudyNetTabUrl(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => (s || "").trim().toLowerCase();
    const links = Array.from(document.querySelectorAll("#section-tabs a"));
    const isTool = (a) => /\/external_tools\//.test(a.getAttribute("href") || a.href);
    let match = links.find((a) => norm(a.textContent) === norm(label) && isTool(a));
    if (!match) match = links.find((a) => norm(a.textContent).includes("study.net") && isTool(a));
    return match ? match.href : null;
  }, label);
}

/**
 * Waits for the study.net materials frame to render inside the tab. The Canvas
 * tab auto-POSTs a signed LTI form into an iframe, which redirects through
 * lti.study.net and lands on the www.study.net materials list; we want that
 * final content-bundle frame, identified by its per-material download buttons.
 * @returns {Promise<import('puppeteer').Frame|null>}
 */
async function waitForMaterialsFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page
      .frames()
      .filter((f) => isStudyNetHost(f.url()) && /\/content-bundle\//.test(f.url()));
    for (const f of frames) {
      const ready = await f
        .evaluate(() => document.querySelectorAll("[onclick^='downloadFile(']").length > 0)
        .catch(() => false);
      if (ready) return f;
    }
    await sleep(1500);
  }
  return null;
}

/**
 * Reads the material list from inside the study.net frame, preserving the
 * instructor's ordering. The list is a flat table of rows; each row is either a
 * downloadable material (a `downloadFile('<matToken>')` handler whose JWT payload
 * leaks the material name and underlying filename) or a website link the
 * instructor included (`viewWebsite('<url>')`). Every item carries its 1-based
 * position so downloads keep the course order on disk. Also returns the runtime
 * download endpoint (window.downloadUrl -> watermark.study.net).
 */
async function listMaterials(frame) {
  return frame.evaluate(() => {
    const decode = (jwt) => {
      try {
        let s = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        s += "=".repeat((4 - (s.length % 4)) % 4);
        return JSON.parse(decodeURIComponent(escape(atob(s)))).data || {};
      } catch (e) {
        return {};
      }
    };
    // Row title from the row's "details" modal trigger (setModalData's first arg,
    // which may be \xNN-escaped), used for website rows that have no JWT.
    const rowTitle = (row) => {
      const md = row && row.querySelector("[onclick^='setModalData(']");
      const m = md && (md.getAttribute("onclick") || "").match(/setModalData\('((?:\\x..|[^'])*)'/);
      if (!m) return "";
      try {
        return m[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      } catch (e) {
        return m[1];
      }
    };
    // Map each material/website action to its table row (<tr>/<li>), in document
    // order, deduped — this naturally excludes footer/modal buttons (in <div>s).
    const rowOf = (el) => {
      let n = el;
      while (n) {
        const t = n.tagName ? n.tagName.toLowerCase() : "";
        if (t === "tr" || t === "li") return n;
        n = n.parentElement;
      }
      return null;
    };
    const rows = [];
    document
      .querySelectorAll("[onclick^='downloadFile('], [onclick^='viewWebsite(']")
      .forEach((el) => {
        const row = rowOf(el);
        if (row && !rows.includes(row)) rows.push(row);
      });

    const items = [];
    rows.forEach((row, i) => {
      const position = i + 1;
      const dl = row.querySelector("[onclick^='downloadFile(']");
      const web = row.querySelector("[onclick^='viewWebsite(']");
      if (dl) {
        const m = (dl.getAttribute("onclick") || "").match(/downloadFile\('([^']+)'\)/);
        if (!m) return;
        const d = decode(m[1]);
        items.push({
          position,
          kind: "file",
          token: m[1],
          name: d.Mat_Name || rowTitle(row) || "",
          matUrl: d.Mat_Url || "",
          matId: d.Mat_ID || "",
        });
      } else if (web) {
        const m = (web.getAttribute("onclick") || "").match(/viewWebsite\('([^']+)'\)/);
        items.push({ position, kind: "link", url: m ? m[1] : "", name: rowTitle(row) || "" });
      }
    });

    const downloadUrl =
      typeof window.downloadUrl === "string" && window.downloadUrl
        ? window.downloadUrl
        : "https://watermark.study.net/viewmat.php";
    return { downloadUrl, items };
  });
}

/**
 * Downloads one material from inside the frame by POSTing its matToken (as
 * multipart form data, the shape the app's axios call uses) to the watermark
 * endpoint. Returns the bytes base64-encoded, or a content-error marker.
 */
async function downloadOne(frame, downloadUrl, token) {
  return frame.evaluate(
    async (downloadUrl, token) => {
      const body = new FormData();
      body.set("matToken", token);
      const res = await fetch(downloadUrl, { method: "POST", credentials: "include", body });
      const contentError = res.headers.get("content-error");
      const contentFilename = res.headers.get("content-filename") || "";
      if (contentError) return { contentError };
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }
      return { contentFilename, bytes: buf.length, base64: btoa(bin) };
    },
    downloadUrl,
    token
  );
}

/** Appends the material's real file extension (from its Mat_Url) if missing. */
function withExtension(name, matUrl, contentFilename) {
  let base = name || contentFilename || "material";
  const ext = ((matUrl || contentFilename).split(".").pop() || "").toLowerCase();
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext) && !base.toLowerCase().endsWith("." + ext)) {
    base += "." + ext;
  }
  return base;
}

/** Zero-padded ordering prefix so files keep the instructor's course order on disk. */
function orderPrefix(position, total) {
  const width = Math.max(2, String(total).length);
  return String(position).padStart(width, "0");
}

/**
 * Scrapes the course's "Study.Net Materials" tab: performs the signed LTI launch
 * in the authenticated browser (which establishes the study.net session), reads
 * the rendered materials list, and downloads each material (per-user watermarked
 * PDF/xlsx/etc.) into `dir/STUDYNET`. Best-effort and never throws. Materials
 * that are view-only (e.g. a website link) or that the endpoint refuses are
 * surfaced so they can be opened from the Study.Net tab manually.
 */
async function scrapeStudyNet(browser, cookies, url, dir) {
  console.log("=== SCRAPING STUDY.NET ===");
  const studynetDir = `${dir}/STUDYNET`;

  let coursePage;
  let toolPage;
  try {
    fs.mkdirSync(studynetDir, { recursive: true });

    const label =
      JSON.parse(process.env.config || "{}").studyNetTabLabel || "Study.Net Materials";

    // 1. Load the course page and find the "Study.Net Materials" nav tab.
    coursePage = await helpers.newPage(browser, cookies, url);
    if (coursePage.status !== 200) {
      helpers.print("ERROR", "STUDY.NET", "Could not load course page. Skipping...", 0);
      return;
    }
    const tabUrl = await findStudyNetTabUrl(coursePage, label).catch(() => null);
    if (!tabUrl) {
      helpers.print(
        "WARNING",
        "STUDY.NET",
        `No "${label}" tab found in the course navigation. Skipping...`,
        0
      );
      return;
    }

    // 2. Launch the tab. Canvas auto-submits a single-use signed LTI form into an
    //    iframe; loading the page live lets Canvas mint a fresh signature.
    toolPage = await browser.newPage();
    if (cookies && cookies.length) await toolPage.setCookie(...cookies);
    await toolPage
      .goto(tabUrl, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});

    // 3. Wait for the materials frame. If Canvas hasn't auto-submitted the launch
    //    form after a moment, submit it ourselves (once) and wait again.
    let frame = await waitForMaterialsFrame(toolPage, 15000);
    if (!frame) {
      await toolPage
        .evaluate(() => {
          const f = Array.from(document.querySelectorAll("form")).find((f) =>
            /study\.net/i.test(f.action || "")
          );
          if (f) f.submit();
        })
        .catch(() => {});
      frame = await waitForMaterialsFrame(toolPage, 30000);
    }
    if (!frame) {
      helpers.print(
        "WARNING",
        "STUDY.NET",
        `Could not reach the Study.Net materials list. Open it manually: ${tabUrl}`,
        0
      );
      return;
    }

    // 4. Read the material list and download each item.
    const { downloadUrl, items } = await listMaterials(frame);
    if (!items.length) {
      helpers.print(
        "WARNING",
        "STUDY.NET",
        "No downloadable materials found (they may be view-only). Open the tab manually.",
        0
      );
      return;
    }

    const files = items.filter((i) => i.kind === "file");
    helpers.print(
      "NOTE",
      "STUDY.NET",
      `Found ${items.length} item(s) (${files.length} downloadable). Downloading...`,
      0
    );
    const problems = [];
    for (const item of items) {
      // A leading NN- keeps the instructor's ordering intact on disk (materials
      // otherwise sort alphabetically). The position counts website links too,
      // so the numbering matches what the student sees in the tab.
      const prefix = orderPrefix(item.position, items.length);

      // Website link the instructor listed: save a pointer, not a download.
      if (item.kind === "link") {
        const name = helpers.stripInvalid(item.name || item.url || "link");
        fs.writeFileSync(
          `${studynetDir}/${prefix} - ${name}.url`,
          `[InternetShortcut]\r\nURL=${item.url}\r\n`
        );
        helpers.print("NOTE", "STUDY.NET", `Saved ${prefix} - ${name}.url (website link)`, 1);
        continue;
      }

      const res = await downloadOne(frame, downloadUrl, item.token).catch(() => null);
      if (!res || res.contentError || !res.base64) {
        problems.push(item.name || item.matId);
        helpers.print(
          "WARNING",
          "STUDY.NET",
          `Could not download "${item.name || item.matId}"${
            res && res.contentError ? ` (${res.contentError})` : ""
          }`,
          1
        );
        continue;
      }
      const filename = helpers.stripInvalid(
        `${prefix} - ${withExtension(item.name, item.matUrl, res.contentFilename)}`
      );
      fs.writeFileSync(`${studynetDir}/${filename}`, Buffer.from(res.base64, "base64"));
      helpers.print("NOTE", "STUDY.NET", `Saved ${filename}`, 1);
    }

    if (problems.length) {
      helpers.print(
        "WARNING",
        "STUDY.NET",
        `${problems.length} item(s) could not be downloaded (view-only or unavailable). ` +
          `Open the Study.Net tab to view them: ${tabUrl}`,
        0
      );
    }
  } catch (e) {
    helpers.print("ERROR", "STUDY.NET", "Could not scrape the Study.Net page", 0, e);
  } finally {
    if (coursePage) await coursePage.close().catch(() => {});
    if (toolPage) await toolPage.close().catch(() => {});
    console.log("=== DONE SCRAPING STUDY.NET ===");
  }
}

export default scrapeStudyNet;
