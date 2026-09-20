import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import os from "os";
import http from "http";
import { spawn } from "child_process";
import { Browser, Page } from "puppeteer";
import { Readable } from "stream";

import report from "./report.js";

let warnedMissingYtDlp = false;
// Cached path to the Netscape cookie file generated for yt-dlp (built once).
let ytDlpCookieFile = null;
// A browser-like User-Agent for plain fetches of external resources. Many news
// sites (nytimes.com, etc.) return 403 to a header-less request; presenting a
// real browser UA gets past the crudest bot filters.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
// Cache of each course's home-page type (default_view), keyed by course URL,
// so the redirect guard in scrapeSections queries the API at most once/course.
const courseDefaultViewCache = new Map();

/** A puppeteer frame's URL, or "" if it can't be read (used for diagnostics). */
function safeFrameUrl(frame) {
  try {
    return frame.url() || "";
  } catch (e) {
    return "";
  }
}

const exported = {
  /**
   * Creates a new page with the given cookies and navigates to the given URL.
   *
   * Opening a target (browser.newPage) and the first navigation are the two
   * places Puppeteer surfaces transient protocol failures under load —
   * "Target.createTarget timed out" and "Requesting main frame too early!" —
   * which abort a whole assignment/module. We retry those (with a fresh target
   * each time and a short backoff) instead of letting one flaky tab kill the run.
   * @param {Browser} browser puppeteer browser
   * @param {Object} cookies cookies to use
   * @param {string} url URL to navigate to
   * @returns {Promise<Page>} new page
   */
  async newPage(browser, cookies, url) {
    const attempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let page;
      try {
        page = await browser.newPage();
        if (cookies && cookies.length) await page.setCookie(...cookies);
        const response = await page.goto(url, { timeout: 60000 });
        // A same-document navigation (or a 204/aborted request) yields no
        // response; treat an unknown status as 0 so callers see "not 200"
        // rather than throwing on response.status().
        page.status = response ? response.status() : 0;
        return page;
      } catch (e) {
        lastErr = e;
        if (page) await page.close().catch(() => {});
        // Only retry the transient protocol/target failures; a real error (bad
        // URL, etc.) should surface immediately.
        if (attempt === attempts || !this.isTransientPageError(e)) throw e;
        this.print(
          "WARNING",
          "BROWSER",
          `Transient page load failure (attempt ${attempt}/${attempts}); retrying ${url}`,
          1,
          e.message
        );
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw lastErr;
  },

  /**
   * Whether an error thrown while opening/navigating a page is a transient
   * browser-protocol hiccup worth retrying (rather than a real failure).
   * @param {any} e
   * @returns {boolean}
   */
  isTransientPageError(e) {
    const msg = (e && e.message) || String(e || "");
    return /Target\.createTarget timed out|Requesting main frame too early|Navigation timeout|Runtime\.callFunctionOn timed out|Protocol error|Target closed|Session closed|socket hang up|net::ERR_/i.test(
      msg
    );
  },

  /**
   * Sanitizes a string to be used as a macOS-compatible filename.
   * Replaces filesystem-illegal characters (including macOS's "/" and ":"),
   * strips control/leading/trailing junk, and enforces a safe length.
   * @param {string} string string to sanitize
   * @returns {string} sanitized filename (never empty)
   */
  stripInvalid(string) {
    let name = String(string ?? "")
      // illegal/unsafe characters -> "-"
      .replaceAll(/[/\\?%*:|"<>]/g, "-")
      // control characters
      .replaceAll(/[\x00-\x1f]/g, "")
      // collapse runs of whitespace/dashes
      .replaceAll(/\s+/g, " ")
      .replaceAll(/-{2,}/g, "-")
      .trim()
      // no leading/trailing dots or spaces (avoids hidden/".."/trailing-dot names)
      .replaceAll(/^[.\s]+|[.\s]+$/g, "");

    if (!name) return "untitled";

    // Windows reserved device names (case-insensitive, with or without an
    // extension) can't be used as a file/folder name — prefix an underscore.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
      name = `_${name}`;
    }

    // truncate to a safe byte length, preserving the extension
    const MAX_BYTES = 200;
    if (Buffer.byteLength(name, "utf8") > MAX_BYTES) {
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      let truncated = base;
      while (Buffer.byteLength(truncated + ext, "utf8") > MAX_BYTES) {
        truncated = truncated.slice(0, -1);
      }
      name = (truncated.trim() || "untitled") + ext;
    }

    return name;
  },

  /**
   * Downloads a file from the given URL using the given cookies
   * @param {string} url URL to download from
   * @param {object} cookies cookies to use
   * @param {string} dir directory to download to
   * @param {string} backupName name to use if no filename is found in the response headers
   * @returns {Promise<boolean>} whether or not the file was downloaded successfully
   */
  async downloadFile(url, cookies, dir, backupName) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Cookie: cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; "),
      },
    });

    // A non-2xx response never carries the file; bail before writing anything
    // (e.g. an expired session yields a 401/403, or a broken link a 404).
    if (!response.ok) {
      report.recordFailure(url, this.describeHttpFailure(url, response.status));
      return false;
    }

    let filename = backupName;
    const contentDisposition = response.headers.get("content-disposition");
    if (contentDisposition) {
      // Servers spell the filename several ways; try each in preference order:
      //   filename*=UTF-8''name.pdf  (RFC 5987, percent-encoded)
      //   filename="name.pdf"        (quoted)
      //   filename=name.pdf          (bare)
      let extracted;
      const star = contentDisposition.match(/filename\*=(?:[^']*''|)([^;]+)/i);
      if (star) {
        try {
          extracted = decodeURIComponent(star[1].trim());
        } catch {
          extracted = star[1].trim();
        }
      } else {
        const quoted = contentDisposition.match(/filename="([^"]+)"/i);
        const bare = contentDisposition.match(/filename=([^;]+)/i);
        extracted = quoted ? quoted[1] : bare ? bare[1].trim() : undefined;
      }
      if (extracted) filename = this.stripInvalid(extracted);
    }

    // No content-disposition filename means the server likely returned an error
    // page instead of the file — the caller treats this as a failed download.
    const ok = filename !== backupName;

    // Dry-run: the fetch above already proved accessibility; record it and skip
    // writing any bytes to disk.
    if (this.dryRun) {
      try {
        response.body?.destroy();
      } catch (e) {
        // ignore
      }
      if (ok) report.recordAvailable(url, "file");
      else report.recordFailure(url, "no file returned (missing content-disposition)");
      return ok;
    }

    const filePath = path.join(dir, filename);
    await this.streamToFile(response, filePath, filename);
    if (ok) report.record(filePath, url);
    else report.recordFailure(url, "no file returned (missing content-disposition)");
    return ok;
  },

  /**
   * Downloads files from an array of URLs using the given cookies
   * @param {Array<string>} urls URLs to download from
   * @param {object} cookies cookies to use
   * @param {string} dir directory to download to
   * @returns {Promise<Array<string>>} array of URLs that could not be downloaded
   */
  async downloadFiles(urls, cookies, dir) {
    let problematic = [];

    for (let i = 0; i < urls.length; i++) {
      let success = await this.downloadFile(
        urls[i],
        cookies,
        `${dir}`,
        `download_${i}.txt`
      );
      if (!success) problematic.push(urls[i]);
    }

    return problematic;
  },

  /**
   * Searches for links via a selector that include a certain string and downloads them
   * @param {Page} page page to search on
   * @param {Object} cookies cookies to use
   * @param {string} dir directory to download to
   * @param {string} selector query selector to search for links
   * @param {string} includes string that the link must include
   * @returns {Promise<Array<string>>} array of URLs that could not be downloaded
   */
  async searchAndDownload(
    page,
    cookies,
    dir,
    selector = "a",
    includes = "download?download"
  ) {
    let downloads = await page.evaluate(
      (selector, includes) => {
        return Array.from(document.querySelectorAll(selector))
          .map((a) => a.href)
          .filter((url) => url.includes(includes));
      },
      selector,
      includes
    );

    return await this.downloadFiles(downloads, cookies, dir);
  },

  /**
   * Lists the courses the user is enrolled in. Tries the Canvas REST API first
   * (session-cookie auth, with pagination); if that returns nothing (e.g the
   * institution blocks cookie-auth API access), falls back to scraping the
   * /courses HTML page with the browser. Date-restricted courses are skipped.
   * @param {string} domain e.g "https://canvas.mit.edu"
   * @param {Array<object>} cookies session cookies
   * @param {Browser} [browser] puppeteer browser (needed for the HTML fallback)
   * @returns {Promise<Array<{id: (string|number), name: string}>>}
   */
  async listCourses(domain, cookies, browser) {
    const cookieHeader = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    const courses = [];
    const seen = new Set();
    const add = (id, name) => {
      if (id === undefined || id === null) return;
      const key = String(id);
      if (seen.has(key)) return;
      seen.add(key);
      courses.push({ id, name: name || `course-${id}` });
    };

    // 1. Preferred: the Canvas REST API, paginated. No enrollment_state filter so
    //    past/completed courses are included too (date-restricted ones are skipped
    //    below since they can't be opened anyway).
    let url = `${domain}/api/v1/courses?per_page=100`;
    let guard = 0;
    while (url && guard++ < 50) {
      let response;
      try {
        response = await fetch(url, {
          headers: { Cookie: cookieHeader, Accept: "application/json" },
        });
      } catch (e) {
        break;
      }
      if (!response.ok) break;

      let pageItems;
      try {
        pageItems = await response.json();
      } catch (e) {
        break;
      }
      if (Array.isArray(pageItems)) {
        for (const c of pageItems) {
          if (!c || c.access_restricted_by_date) continue;
          add(c.id, c.name);
        }
      }

      // follow the rel="next" link header for pagination
      url = null;
      const link = response.headers.get("link");
      if (link) {
        for (const part of link.split(",")) {
          if (/rel="next"/.test(part)) {
            const m = part.match(/<([^>]+)>/);
            if (m) url = m[1];
            break;
          }
        }
      }
    }

    if (courses.length || !browser) return courses;

    // 2. Fallback: scrape the /courses page (anchors to /courses/<numeric id>).
    this.print(
      "NOTE",
      "COURSES",
      "Course API returned nothing; falling back to the /courses page...",
      0
    );
    let page;
    try {
      page = await this.newPage(browser, cookies, `${domain}/courses`);
      if (page.status === 200) {
        const found = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('a[href*="/courses/"]').forEach((a) => {
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/courses\/(\d+)(?:$|[/?#])/);
            if (!m) return;
            const name = (a.textContent || "").trim();
            if (!name) return;
            out.push({ id: m[1], name });
          });
          return out;
        });
        for (const c of found) add(c.id, c.name);
      }
    } catch (e) {
      // ignore; return whatever we have
    } finally {
      if (page) await page.close().catch(() => {});
    }

    return courses;
  },

  /**
   * Looks up a single course's name via the Canvas REST API (session-cookie
   * auth). Used to name the per-course output folder in single-course mode.
   * @param {string} domain e.g "https://canvas.mit.edu"
   * @param {(string|number)} courseId the course id from the URL
   * @param {Array<object>} cookies session cookies
   * @returns {Promise<string|null>} the course name, or null if unavailable
   */
  async getCourseName(domain, courseId, cookies) {
    const cookieHeader = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    try {
      const response = await fetch(`${domain}/api/v1/courses/${courseId}`, {
        headers: { Cookie: cookieHeader, Accept: "application/json" },
      });
      if (!response.ok) return null;
      const course = await response.json();
      const name = course && typeof course.name === "string" ? course.name.trim() : "";
      return name || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Built-in hostnames whose links should be downloaded with yt-dlp (which
   * natively supports these providers) rather than fetched as plain files.
   * Extra hosts can be added via the "videoHosts" array in config.json.
   */
  defaultVideoHosts: [
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "panopto.com",
  ],

  _videoHostsCache: null,

  /**
   * The full list of video hostnames: the built-in defaults plus any extras
   * configured in config.json's "videoHosts" array (lowercased, deduped).
   * @returns {Array<string>}
   */
  getVideoHosts() {
    if (this._videoHostsCache) return this._videoHostsCache;
    let extra = [];
    try {
      const cfg = process.env.config ? JSON.parse(process.env.config) : {};
      if (Array.isArray(cfg.videoHosts)) {
        extra = cfg.videoHosts.map((h) => String(h).toLowerCase());
      }
    } catch (e) {
      // ignore malformed config; fall back to defaults
    }
    this._videoHostsCache = [...new Set([...this.defaultVideoHosts, ...extra])];
    return this._videoHostsCache;
  },

  /**
   * Whether a hostname matches one of the yt-dlp video providers (exact match
   * or a subdomain of one).
   * @param {string} hostname lowercase hostname
   * @returns {boolean}
   */
  isVideoHost(hostname) {
    return this.getVideoHosts().some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
  },

  /**
   * Explains, for the skipped report, why a non-2xx HTTP response means the file
   * couldn't be fetched. A Canvas file 403 almost always means the file is locked
   * or restricted by the instructor (the session is still valid — other files in
   * the same run download fine), so we say so rather than implying an auth error.
   * @param {string} url the URL that returned the error
   * @param {number} status the HTTP status code
   * @returns {string}
   */
  describeHttpFailure(url, status) {
    const isCanvasFile = /\/files\/\d+\/download/.test(url || "");
    if (status === 403) {
      return isCanvasFile
        ? "locked/restricted file — instructor-locked or unavailable (HTTP 403)"
        : "access denied (HTTP 403)";
    }
    if (status === 401) {
      return "not authorized — session invalid for this item (HTTP 401)";
    }
    if (status === 404) return "not found — link may be broken (HTTP 404)";
    return `HTTP ${status}`;
  },

  /**
   * Explains, for the skipped report, why a link couldn't be downloaded, based on
   * its host. These are provider-side access restrictions rather than scraper or
   * cookie bugs: the content is licensed, paywalled, locked, or only granted
   * inside a live Canvas launch — none of which a session cookie alone unlocks.
   * For Canvas LTI launches the real target lives in the `url` query param, so we
   * inspect that too.
   * @param {string} url the undownloadable URL
   * @param {object} [opts]
   * @param {boolean} [opts.video] whether the URL was treated as a video host
   * @param {boolean} [opts.lti] whether it was reached via a Canvas LTI launch
   * @returns {string}
   */
  describeUndownloadable(url, opts = {}) {
    let hay = String(url || "").toLowerCase();
    try {
      const u = new URL(url);
      hay = `${u.hostname} ${u.searchParams.get("url") || ""}`.toLowerCase();
    } catch (e) {
      // not a parseable URL; fall back to the raw string
    }
    const via = opts.lti ? " (Canvas LTI launch)" : "";
    if (/(^|\.|\/)panopto\.com/.test(hay) || /panopto/.test(hay)) {
      return `Panopto video not downloadable${via} — access is granted only inside the Canvas viewer, not to a standalone request`;
    }
    if (/primo|exlibrisgroup|proquest|ebookcentral|ebscohost|jstor|skillsoft|books24x7|perlego|vlebooks|askewsholts/.test(hay)) {
      return "library-licensed resource — a catalog/reader link, not a downloadable file";
    }
    if (/nytimes|wsj\.com|washingtonpost|bloomberg|ft\.com|economist|forbes|hbr\.org|reuters/.test(hay)) {
      return "paywalled article — the page is login/subscription-gated";
    }
    if (opts.video) {
      return "video not downloadable — provider blocked the request or it is access-restricted";
    }
    if (opts.lti) {
      return "external tool launch not downloadable — no file behind this LTI tool";
    }
    return "not a downloadable file — the page was blocked or requires login";
  },

  /**
   * Classifies a video URL as a "playlist" (a Panopto folder, a provider
   * playlist, etc. — many videos) or a "single" video. Used to decide yt-dlp's
   * output layout and whether to expand playlists.
   * @param {string} url
   * @returns {"playlist"|"single"}
   */
  videoUrlKind(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return "single";
    }
    const host = u.hostname.toLowerCase();
    const pathLower = u.pathname.toLowerCase();
    const params = new Set();
    for (const k of u.searchParams.keys()) params.add(k.toLowerCase());

    if (host === "panopto.com" || host.endsWith(".panopto.com")) {
      // Folders/lists -> playlist; Viewer.aspx / Embed.aspx?id=... -> single
      if (
        params.has("folderid") ||
        pathLower.includes("/folders/") ||
        pathLower.includes("/sessions/list.aspx")
      ) {
        return "playlist";
      }
      return "single";
    }

    // Generic (e.g YouTube): a "list" with no single video id is a playlist
    if (pathLower.includes("/playlist") || (params.has("list") && !params.has("v"))) {
      return "playlist";
    }
    return "single";
  },

  /**
   * Given any Panopto URL that references a folder (an embedded folder view, an
   * LTI landing page with a folderID in the query or hash, etc.), returns a
   * canonical folder URL that yt-dlp's Panopto extractor understands. Returns
   * null if no folder id can be found.
   * @param {string} u a Panopto URL
   * @returns {string|null}
   */
  /**
   * Builds a canonical Panopto folder ("List") URL scoped to a single folder, in
   * the exact form yt-dlp's PanoptoListIE understands. yt-dlp reads the folder id
   * from the URL *fragment* (via `_parse_fragment`), not the query string, and
   * json.loads() each value — so the id must live after the `#` and be wrapped in
   * (URL-encoded) double quotes, e.g. `List.aspx?noredirect=true#folderID="<id>"`.
   * Passing the id in the query string instead makes yt-dlp see no folder and
   * fall back to listing *every* session the user can view (all courses), so this
   * form is required to keep the download scoped to the one course folder.
   * @param {string} origin the Panopto origin, e.g. https://org.hosted.panopto.com
   * @param {string} folderId the folder GUID
   * @returns {string}
   */
  panoptoListUrl(origin, folderId) {
    return `${origin}/Panopto/Pages/Sessions/List.aspx?noredirect=true#folderID=%22${folderId}%22`;
  },

  panoptoFolderUrl(u) {
    try {
      const url = new URL(u);
      let folderId =
        url.searchParams.get("folderID") || url.searchParams.get("folderId");
      if (!folderId && url.hash) {
        // decode first so %22 etc. become real separators, then match the id
        let hash = url.hash;
        try {
          hash = decodeURIComponent(url.hash);
        } catch (e) {
          // keep raw hash
        }
        const m = hash.match(/folder(?:ID)?["':=\s]+([0-9a-fA-F-]{36})/i);
        if (m) folderId = m[1];
      }
      if (folderId) {
        return this.panoptoListUrl(`${url.protocol}//${url.host}`, folderId);
      }
    } catch (e) {
      // not a parseable URL
    }
    return null;
  },

  /**
   * Builds (once) a Netscape-format cookie file from the scraped cookies so
   * yt-dlp can authenticate to login-gated providers (e.g Panopto). Returns the
   * file path, or null if no cookies are available / it could not be written.
   * @param {Array<object>} cookies puppeteer-style cookies (name, value, domain, ...)
   * @returns {string|null}
   */
  getYtDlpCookieFile(cookies) {
    if (ytDlpCookieFile !== null) return ytDlpCookieFile || null;
    if (!cookies || cookies.length === 0) {
      ytDlpCookieFile = "";
      return null;
    }
    try {
      const lines = ["# Netscape HTTP Cookie File"];
      for (const c of cookies) {
        if (!c.name || !c.domain) continue;
        const domain = c.domain;
        const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
        const cookiePath = c.path || "/";
        const secure = c.secure ? "TRUE" : "FALSE";
        // 0 = session cookie; yt-dlp accepts these.
        const expiry = Math.floor(c.expires && c.expires > 0 ? c.expires : 0);
        lines.push(
          [domain, includeSub, cookiePath, secure, expiry, c.name, c.value].join(
            "\t"
          )
        );
      }
      const file = path.join(os.tmpdir(), `canvas-scraper-cookies-${process.pid}.txt`);
      fs.writeFileSync(file, lines.join("\n") + "\n");
      ytDlpCookieFile = file;
      return file;
    } catch (e) {
      this.print("WARNING", "YT-DLP", "Could not build cookie file for yt-dlp", 0, e);
      ytDlpCookieFile = "";
      return null;
    }
  },

  /**
   * Guesses a file extension from a content-type header
   * @param {string|null} contentType content-type header value
   * @returns {string} extension including the leading dot (e.g ".pdf"), or ""
   */
  extFromContentType(contentType) {
    if (!contentType) return "";
    const type = contentType.split(";")[0].trim().toLowerCase();
    const map = {
      "application/pdf": ".pdf",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        ".docx",
      "application/vnd.ms-powerpoint": ".ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        ".pptx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        ".xlsx",
      "application/zip": ".zip",
      "text/html": ".html",
      "text/plain": ".txt",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
    };
    return map[type] || "";
  },

  /**
   * Downloads an externally-hosted file (no Canvas cookies sent). The filename is
   * derived from the content-disposition header, then the URL pathname, then the
   * backup name (with an extension guessed from the content-type).
   * @param {string} url URL to download from
   * @param {string} dir directory to download to
   * @param {string} backupName name to use if none can be derived
   * @returns {Promise<boolean>} whether the file was downloaded successfully
   */
  async downloadExternalFile(url, dir, backupName) {
    let response;
    try {
      response = await fetch(url, { method: "GET", redirect: "follow" });
    } catch (e) {
      return false;
    }
    if (!response.ok) return false;
    return this.writeResponseToFile(url, response, dir, backupName);
  },

  /**
   * Writes an already-fetched response body to a file, deriving the filename from
   * the content-disposition header, then the URL pathname, then the backup name
   * (with an extension guessed from the content-type).
   * @param {string} url the URL the response came from
   * @param {object} response a node-fetch response
   * @param {string} dir directory to write to
   * @param {string} backupName name to use if none can be derived
   * @returns {Promise<boolean>}
   */
  async writeResponseToFile(url, response, dir, backupName) {
    let filename = null;
    const contentDisposition = response.headers.get("content-disposition");
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    if (!filename) {
      try {
        const pathname = new URL(url).pathname;
        const base = decodeURIComponent(pathname.split("/").pop() || "");
        if (base) filename = base;
      } catch (e) {
        // fall through to backup name
      }
    }

    if (!filename) {
      filename =
        backupName + this.extFromContentType(response.headers.get("content-type"));
    }

    filename = this.stripInvalid(filename);

    // Dry-run: the response is accessible; record it and don't write the file.
    if (this.dryRun) {
      try {
        response.body?.destroy();
      } catch (e) {
        // ignore
      }
      report.recordAvailable(url, "file");
      return true;
    }

    const filePath = path.join(dir, filename);
    await this.streamToFile(response, filePath, filename);
    report.record(filePath, url);
    return true;
  },

  /**
   * Downloads an external resource. If it's a webpage (HTML) we render an archival
   * PDF of it with the headless browser; otherwise it's saved as the file it is.
   * @param {Browser} browser puppeteer browser
   * @param {string} url URL to download from
   * @param {string} dir directory to save to
   * @param {number} index index used to build a fallback filename
   * @returns {Promise<boolean>} whether something was saved
   */
  async downloadExternalResource(browser, url, dir, index) {
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": BROWSER_UA },
      });
    } catch (e) {
      response = null;
    }

    // A blocked or failed bare fetch (news paywalls / bot filters return 403 to
    // node-fetch even with a UA) still usually renders in a real browser, which
    // sends full headers and runs the page's scripts. Fall back to archiving it
    // as a PDF rather than giving up.
    if (!response || !response.ok) {
      return this.archiveWebpageAsPdf(browser, url, dir, `external_${index}`);
    }

    const ct = (response.headers.get("content-type") || "").toLowerCase();
    const cd = response.headers.get("content-disposition") || "";
    const isHtml =
      ct.includes("text/html") || ct.includes("application/xhtml+xml");

    if (isHtml && !/attachment/i.test(cd)) {
      // A webpage: discard the fetched HTML and re-render it with the browser so
      // the PDF includes the page's styling, images, and scripted content.
      try {
        response.body.destroy();
      } catch (e) {
        // ignore
      }
      return this.archiveWebpageAsPdf(browser, url, dir, `external_${index}`);
    }

    return this.writeResponseToFile(url, response, dir, `external_${index}`);
  },

  /**
   * Renders an external webpage to a PDF "archive" using the headless browser.
   * Best-effort: paywalled or login-gated pages capture only what is publicly
   * visible, and bot-protected sites may render a blocked page.
   * @param {Browser} browser puppeteer browser
   * @param {string} url webpage URL
   * @param {string} dir directory to save to
   * @param {string} backupName fallback filename (no extension)
   * @returns {Promise<boolean>}
   */
  async archiveWebpageAsPdf(browser, url, dir, backupName) {
    let page;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      // Present a normal browser UA; the default headless UA ("HeadlessChrome")
      // is blocked by some sites (e.g nytimes.com).
      await page.setUserAgent(BROWSER_UA).catch(() => {});
      // Archive what a reader sees (screen styles), not the print stylesheet.
      await page.emulateMediaType("screen").catch(() => {});
      // Render whatever loads; don't fail the whole thing on a slow idle timeout.
      await page
        .goto(url, { waitUntil: "networkidle2", timeout: 30000 })
        .catch(() => {});

      let name = "";
      try {
        name = ((await page.title()) || "").trim();
      } catch (e) {
        // ignore
      }

      // Detect a blocked render. Bot-walled sites (nytimes.com, bloomberg.com,
      // Cloudflare, DataDome, ...) either serve an empty/near-empty page or a
      // recognizable interstitial ("Are you a robot?", "Just a moment...",
      // "enable JavaScript", a captcha). Archiving those produces a junk PDF
      // that masquerades as the article, so report a failure and let the URL
      // surface in the skipped report instead.
      let bodyText = "";
      try {
        bodyText = await page.evaluate(
          () => (document.body && document.body.innerText) || ""
        );
      } catch (e) {
        // ignore
      }
      const len = bodyText.trim().length;
      // Strip the passive "protected by reCAPTCHA/hCaptcha" notice that many
      // legitimate sites embed on newsletter and comment forms (e.g The
      // Atlantic's footer). It is not a bot challenge, and letting the bare
      // "captcha" keyword match it discards a perfectly good archive.
      const probe = `${name}\n${bodyText}`
        .toLowerCase()
        .replace(/protected by (?:google )?(?:re)?captcha|protected by hcaptcha/g, "");
      // A real bot wall serves a near-empty page or a short interstitial, so only
      // trust an interstitial keyword on a short page. A full-length article that
      // mentions one of these phrases in passing (e.g a course reading *about*
      // CAPTCHAs or bot detection) is not blocked.
      const interstitial =
        /are you a robot|just a moment|access (?:to this page has been )?denied|enable javascript|please enable (?:js|cookies)|verify you are (?:a )?human|captcha|unusual traffic|request (?:was )?blocked/;
      const blocked = len < 200 || (len < 1000 && interstitial.test(probe));
      if (blocked) {
        return false;
      }

      // Dry-run: the page rendered and isn't a bot wall, so it's an accessible
      // article — record it and skip writing the PDF.
      if (this.dryRun) {
        report.recordAvailable(url, "webpage");
        return true;
      }

      if (!name) {
        try {
          const u = new URL(url);
          name = (u.hostname + u.pathname).replace(/\/+$/, "").replace(/\//g, "-");
        } catch (e) {
          name = backupName;
        }
      }
      name = this.stripInvalid(name || backupName);
      if (!/\.pdf$/i.test(name)) name += ".pdf";

      const filePath = path.join(dir, name);
      await page.pdf({
        path: filePath,
        format: "Letter",
        printBackground: true,
      });
      report.record(filePath, url);
      return true;
    } catch (e) {
      return false;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  },

  /**
   * Probes a video for accessibility with yt-dlp's --simulate (used by --dry-run):
   * resolves the video/playlist and its formats without downloading any media.
   * Records the result via `report` and returns whether it looks accessible.
   * @param {string} url video URL (viewer/embed/watch/folder page)
   * @param {Array<object>} [cookies] cookies to authenticate with
   * @returns {Promise<boolean>} whether the video appears accessible
   */
  async probeVideo(url, cookies) {
    const args = ["--simulate", "--no-warnings", "--quiet"];
    if (this.videoUrlKind(url) === "single") args.push("--no-playlist");
    const cookieFile = this.getYtDlpCookieFile(cookies);
    if (cookieFile) args.push("--cookies", cookieFile);
    args.push(url);

    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn("yt-dlp", args, { windowsHide: true });
      } catch (e) {
        this.print("WARNING", "YT-DLP", `Could not probe ${url}`, 0, e.message);
        return resolve(false);
      }
      child.stdout && child.stdout.on("data", () => {});
      child.stderr && child.stderr.on("data", () => {});
      child.on("error", (e) => {
        if (e.code === "ENOENT" && !warnedMissingYtDlp) {
          warnedMissingYtDlp = true;
          this.print(
            "WARNING",
            "YT-DLP",
            "yt-dlp is not installed or not on PATH. Skipping video probes. Install it (e.g 'brew install yt-dlp').",
            0
          );
        }
        resolve(false);
      });
      child.on("close", (code) => {
        const ok = code === 0;
        if (ok) report.recordAvailable(url, "video");
        resolve(ok);
      });
    });
  },

  /**
   * Downloads a video as mp4 using yt-dlp (YouTube, Panopto, etc.). When cookies
   * are provided, they are passed to yt-dlp so login-gated providers (Panopto)
   * can authenticate.
   * @param {string} url video URL (viewer/embed/watch page)
   * @param {string} dir directory to download to
   * @param {Array<object>} [cookies] cookies to authenticate with
   * @returns {Promise<boolean>} whether the video was downloaded successfully
   */
  async downloadVideo(url, dir, cookies) {
    // Dry-run: ask yt-dlp to --simulate the download (resolve the video and its
    // formats without fetching any media) so we learn whether it's accessible
    // without downloading gigabytes.
    if (this.dryRun) return this.probeVideo(url, cookies);

    const kind = this.videoUrlKind(url);
    // Use an absolute output path: on Windows yt-dlp only applies extended-length
    // (\\?\) path handling to absolute paths, so a relative -o would hit the
    // 260-char MAX_PATH limit on deep course/module folders.
    const absDir = path.resolve(dir);
    // Folders/playlists nest their videos under a subfolder named for the
    // playlist; single sessions land flat in `dir`.
    const outTemplate =
      kind === "playlist"
        ? path.join(absDir, "%(playlist_title)s", "%(title)s.%(ext)s")
        : path.join(absDir, "%(title)s.%(ext)s");

    const args = [
      "--restrict-filenames",
      "--merge-output-format",
      "mp4",
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
      "-o",
      outTemplate,
      // Emit one machine-readable progress line per update (rather than a
      // \r-updated bar) so we can parse it and drive our own progress display.
      "--newline",
      "--progress-template",
      "download:" +
        [
          "CSVID",
          "%(info.playlist_index)s",
          "%(info.n_entries)s",
          "%(progress.downloaded_bytes)s",
          "%(progress.total_bytes)s",
          "%(progress.total_bytes_estimate)s",
          "%(progress.speed)s",
          "%(progress.eta)s",
          "%(info.title)s",
        ].join("\t"),
    ];

    // For a single video, don't expand any playlist the URL happens to belong to.
    if (kind === "single") args.push("--no-playlist");

    const cookieFile = this.getYtDlpCookieFile(cookies);
    if (cookieFile) args.push("--cookies", cookieFile);

    // Optional post-download transcription: run the configured command on each
    // finished file. Rather than yt-dlp's --exec (opaque), we run it ourselves
    // after the download so we can report transcription progress.
    let transcribeCmd = "";
    if (process.env.transcribe === "true") {
      try {
        transcribeCmd = JSON.parse(process.env.config || "{}").transcribeCommand || "";
      } catch (e) {
        // no/invalid config
      }
    }

    args.push(url);

    // yt-dlp picks its own output filenames (and playlist subfolders), so snapshot
    // the directory and report whatever new files the download adds.
    const before = report.snapshot(absDir);
    // A second, report-independent snapshot so we can find the downloaded media
    // to transcribe even when --report is off (report.snapshot is empty then).
    // Only needed when transcribing.
    const filesBefore = transcribeCmd
      ? new Set(this.listFilesRecursive(absDir))
      : null;

    const num = (s) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn("yt-dlp", args, { windowsHide: true });
      } catch (e) {
        this.print("WARNING", "YT-DLP", `Could not download ${url}`, 0, e.message);
        return resolve(false);
      }

      let stderr = "";
      let outBuf = "";
      let currentTitle = "";

      // Interleaved transcription: as each media file finishes downloading, queue
      // it for transcription (running sequentially in the background) so it
      // overlaps the next download instead of waiting for the whole folder. A
      // file is considered finished once it exists with no temp sibling and its
      // size is stable across two sweeps (so we never grab it mid-merge/move).
      const MEDIA_RE = /\.(mp4|m4a|mkv|webm|mp3|wav)$/i;
      const queued = new Set();
      const sizes = new Map();
      let transcribeChain = Promise.resolve();
      const sweep = () => {
        if (!transcribeCmd || !filesBefore) return;
        for (const f of this.listFilesRecursive(absDir)) {
          if (queued.has(f) || filesBefore.has(f) || !MEDIA_RE.test(f)) continue;
          let size;
          try {
            size = fs.statSync(f).size;
          } catch (e) {
            continue;
          }
          if (size <= 0) continue;
          if (sizes.get(f) !== size) {
            sizes.set(f, size); // record; enqueue only once it's stable
            continue;
          }
          queued.add(f);
          transcribeChain = transcribeChain.then(() =>
            this.runTranscribeOne(transcribeCmd, f, queued.size, null)
          );
        }
      };
      const sweepTimer =
        transcribeCmd && filesBefore ? setInterval(sweep, 1500) : null;
      const stopSweep = () => {
        if (sweepTimer) clearInterval(sweepTimer);
      };

      // Parse one "download:" progress-template line (tab-separated, prefixed
      // with our CSVID sentinel) and report it. Non-matching stdout is ignored.
      const handleLine = (line) => {
        if (!line.startsWith("CSVID\t")) return;
        const p = line.split("\t");
        const index = num(p[1]);
        const count = num(p[2]);
        const received = num(p[3]);
        const total = num(p[4]) ?? num(p[5]); // total, else estimate
        const speed = num(p[6]);
        const eta = num(p[7]);
        const title = p.slice(8).join("\t").trim();
        const name = title || url;
        if (title && title !== currentTitle) {
          currentTitle = title;
          this.emitProgress({ scope: "video", phase: "start", name, index, count });
        }
        this.emitProgress({
          scope: "video",
          phase: "progress",
          name,
          received,
          total,
          percent: total ? (received / total) * 100 : null,
          speed,
          eta,
          index,
          count,
        });
      };

      child.stdout.on("data", (d) => {
        outBuf += d.toString();
        let nl;
        while ((nl = outBuf.indexOf("\n")) >= 0) {
          const line = outBuf.slice(0, nl).replace(/\r$/, "");
          outBuf = outBuf.slice(nl + 1);
          handleLine(line);
        }
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      child.on("error", (e) => {
        stopSweep();
        if (e.code === "ENOENT") {
          if (!warnedMissingYtDlp) {
            warnedMissingYtDlp = true;
            this.print(
              "WARNING",
              "YT-DLP",
              "yt-dlp is not installed or not on PATH. Skipping video downloads. Install it (e.g 'brew install yt-dlp').",
              0
            );
          }
          return resolve(false);
        }
        this.print("WARNING", "YT-DLP", `Could not download ${url}`, 0, e.message);
        resolve(false);
      });

      child.on("close", async (code) => {
        stopSweep();
        this.emitProgress({
          scope: "video",
          phase: "done",
          name: currentTitle || url,
        });
        // Catch any files finished right before exit (two passes satisfy the
        // size-stability check for the last file), then let all queued
        // transcriptions run to completion.
        if (transcribeCmd && filesBefore) {
          sweep();
          sweep();
          await transcribeChain;
        }
        if (code === 0) {
          report.recordNewFiles(absDir, before, url);
          return resolve(true);
        }
        // ENOENT is handled by the 'error' handler above (no 'close' with 0).
        this.print(
          "WARNING",
          "YT-DLP",
          `Could not download ${url}`,
          0,
          stderr.trim() || `yt-dlp exited with code ${code}`
        );
        resolve(false);
      });
    });
  },

  /** Lists every file under `dir` recursively (absolute paths). */
  listFilesRecursive(dir) {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.listFilesRecursive(full));
      else out.push(full);
    }
    return out;
  },

  /** Wraps a path for a shell command (double-quoted; matches yt-dlp's --exec). */
  shellQuote(p) {
    return `"${String(p).replace(/(["\\$`])/g, "\\$1")}"`;
  },

  /**
   * Runs one transcription, emitting scope:"transcribe" progress events. Mirrors
   * yt-dlp's --exec: "{}" in the command is replaced with the file path (quoted);
   * if absent, the path is appended.
   */
  runTranscribeOne(cmd, file, index, count) {
    return new Promise((resolve) => {
      const name = path.basename(file);
      const quoted = this.shellQuote(file);
      const fullCmd = cmd.includes("{}")
        ? cmd.replaceAll("{}", quoted)
        : `${cmd} ${quoted}`;

      this.emitProgress({ scope: "transcribe", phase: "start", name, index, count });
      const start = Date.now();
      let percent = null;

      let child;
      try {
        child = spawn(fullCmd, { shell: true });
      } catch (e) {
        this.print("WARNING", "TRANSCRIBE", `Could not transcribe ${name}`, 1, e.message);
        this.emitProgress({ scope: "transcribe", phase: "done", name, index, count });
        return resolve();
      }

      // Emit a heartbeat so the elapsed time keeps ticking even when the tool
      // is quiet (many transcribers print nothing until they finish).
      const timer = setInterval(() => {
        this.emitProgress({
          scope: "transcribe",
          phase: "progress",
          name,
          percent,
          elapsed: (Date.now() - start) / 1000,
          index,
          count,
        });
      }, 1000);

      // Best-effort percent: most whisper-family tools print a "NN%" somewhere.
      const scan = (buf) => {
        const m = String(buf).match(/(\d{1,3})\s*%/g);
        if (m) {
          const p = parseInt(m[m.length - 1], 10);
          if (Number.isFinite(p)) percent = Math.max(0, Math.min(100, p));
        }
      };
      if (child.stdout) child.stdout.on("data", scan);
      if (child.stderr) child.stderr.on("data", scan);

      const finish = () => {
        clearInterval(timer);
        this.emitProgress({
          scope: "transcribe",
          phase: "done",
          name,
          percent,
          elapsed: (Date.now() - start) / 1000,
          index,
          count,
        });
        resolve();
      };

      child.on("error", (e) => {
        this.print("WARNING", "TRANSCRIBE", `Could not transcribe ${name}`, 1, e.message);
        finish();
      });
      child.on("close", finish);
    });
  },

  /**
   * Attempts to download a PDF from a Canvas LTI external-tool launch that points
   * at Harvard Business Publishing. Navigating the Canvas `retrieve` URL with the
   * authenticated browser performs the signed LTI launch and lands on the HBS
   * content-launch page, which contains a "Download PDF" form (POST, same-origin,
   * authorized by the session the launch established). We submit that form from
   * within the page and save the returned bytes.
   * @param {Browser} browser puppeteer browser
   * @param {Array<object>} cookies cookies to authenticate with
   * @param {string} retrieveUrl the Canvas `…/external_tools/retrieve?url=…` link
   * @param {string} dir directory to save the PDF to
   * @returns {Promise<{handled: boolean, ok?: boolean, reason?: string}>}
   *   handled=false means this wasn't an HBS launch (caller should treat it as
   *   un-downloadable); reason, when set, is a specific skip explanation (e.g
   *   expired coursepack access) for the report.
   */
  async downloadLtiPdf(browser, cookies, retrieveUrl, dir) {
    let targetParam = null;
    try {
      targetParam = new URL(retrieveUrl).searchParams.get("url");
    } catch (e) {
      // not a parseable URL; fall through to the ref check below
    }
    // Only handle Harvard Business Publishing launches.
    if (!/hbsp\.harvard\.edu/i.test(`${targetParam || ""} ${retrieveUrl}`)) {
      return { handled: false };
    }

    // Accumulate a snapshot of what the launch actually did, so a failure the
    // user can complete by hand (these HBSP links open fine in a browser) still
    // leaves enough behind to update the scraper: the landed URL, HTTP status,
    // page title/text, and — per frame — whether the download form was present
    // and what its POST returned. Recorded to download-diagnostics.jsonl on any
    // unsuccessful outcome via fail().
    const diag = {
      kind: "lti-pdf",
      url: retrieveUrl,
      target: targetParam || "",
      destDir: dir || "",
      httpStatus: null,
      landedUrl: "",
      launchFormSubmitted: null,
      docTitle: "",
      bodyTextSnippet: "",
      frames: [],
    };
    const fail = (outcome, reason) => {
      diag.outcome = outcome;
      if (reason) diag.reason = reason;
      try {
        report.recordDiagnostic(diag);
      } catch (e) {
        // never let diagnostics tracking interfere with the download flow
      }
      return { handled: true, ok: false, ...(reason ? { reason } : {}) };
    };

    let page;
    try {
      page = await this.newPage(browser, cookies, retrieveUrl);
      diag.httpStatus = page.status;
      await page.setUserAgent(BROWSER_UA).catch(() => {});
      // The launch auto-submits a signed form; give it a moment to settle.
      await page
        .waitForNetworkIdle({ idleTime: 1000, timeout: 15000 })
        .catch(() => {});

      // Perform the signed LTI launch ourselves. Canvas only auto-submits the
      // launch form for tools placed inline (iframe); this HBS tool is placed
      // "open in a new window", so the retrieve page just shows a "Load in a new
      // window" button and never navigates on its own. Submitting the form into
      // the top frame lands us on the real HBS content page.
      const launched = await page
        .evaluate(() => {
          const f = Array.from(document.querySelectorAll("form")).find((x) =>
            /hbsp\.harvard\.edu/i.test(x.action)
          );
          if (!f) return false;
          f.target = "_self";
          f.submit();
          return true;
        })
        .catch(() => false);
      diag.launchFormSubmitted = launched;
      if (launched) {
        await page
          .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
          .catch(() => {});
      }
      try {
        diag.landedUrl = page.url();
      } catch (e) {
        // ignore
      }

      // HBS shows a plain status page (no download) when the coursepack link's
      // access window has ended or the item isn't entitled. Detect those so the
      // skipped report explains the real reason instead of a generic failure.
      let landedText = "";
      try {
        landedText = await page.evaluate(
          () => (document.body && document.body.innerText) || ""
        );
      } catch (e) {
        // ignore
      }
      diag.bodyTextSnippet = landedText.slice(0, 1000);
      if (/content access .*has expired/i.test(landedText)) {
        return fail("hbsp-expired", "HBSP content access expired");
      }
      if (/(not (?:been )?(?:granted|entitled|authorized)|no access|please (?:sign in|log in))/i.test(landedText)) {
        return fail("hbsp-not-accessible", "HBSP content not accessible");
      }

      // The content-launch page titles itself with the readable case name (e.g
      // "Assembling the Startup Team"); HBS only sends a coded content-disposition
      // filename ("812122-PDF-ENG.pdf"), so prefer this for a human-readable file.
      let docTitle = "";
      try {
        docTitle = ((await page.title()) || "").trim();
      } catch (e) {
        // ignore
      }
      if (/harvard business publishing/i.test(docTitle)) docTitle = "";
      diag.docTitle = docTitle;

      // The HBS page may be the top frame or an embedded tool iframe.
      for (const frame of page.frames()) {
        let result = null;
        try {
          result = await frame.evaluate(async () => {
            const form =
              document.querySelector("form#pdfLaunch") ||
              Array.from(document.querySelectorAll("form")).find((f) =>
                /\/pdf-downloads(\/|\?|$)/.test(f.action)
              );
            if (!form) return null;

            const params = new URLSearchParams();
            for (const el of form.elements) {
              if (el.name) params.append(el.name, el.value);
            }
            const availabilityId =
              (form.querySelector('[name="availabilityId"]') || {}).value || "";

            const res = await fetch(form.action, {
              method: "POST",
              body: params,
              credentials: "include",
              redirect: "follow",
            });
            const ct = res.headers.get("content-type") || "";
            const cd = res.headers.get("content-disposition") || "";
            // Report the form action, status, and headers on every path so a
            // failed download can be diagnosed (e.g a 403 or an HTML error page
            // returned where a PDF was expected).
            const meta = {
              formAction: form.action,
              status: res.status,
              contentType: ct,
              contentDisposition: cd,
            };
            if (!res.ok) return { ok: false, ...meta };
            if (!/pdf|octet-stream/i.test(ct) && !/\.pdf/i.test(cd)) {
              return { ok: false, notPdf: true, ...meta };
            }
            const bytes = new Uint8Array(await res.arrayBuffer());
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(
                null,
                bytes.subarray(i, i + chunk)
              );
            }
            return {
              ok: true,
              base64: btoa(binary),
              contentDisposition: cd,
              availabilityId,
              ...meta,
            };
          });
        } catch (e) {
          // Record that this frame was probed but threw, then move on.
          diag.frames.push({ frameUrl: safeFrameUrl(frame), error: e.message });
          result = null;
        }

        if (result === null) continue; // no PDF form in this frame
        // Snapshot the frame's form/POST outcome (without the PDF bytes).
        const { base64, ...frameMeta } = result;
        diag.frames.push({ frameUrl: safeFrameUrl(frame), ...frameMeta });
        if (!result.ok) return fail("pdf-post-failed");

        // Prefer the readable case title; otherwise the server's filename (the
        // regex tolerates spaces around '=', which HBS emits), then the id.
        let filename = docTitle || null;
        if (!filename) {
          const m =
            result.contentDisposition &&
            result.contentDisposition.match(
              /filename\*?\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i
            );
          if (m) {
            try {
              filename = decodeURIComponent(m[1].trim());
            } catch (e) {
              filename = m[1].trim();
            }
          }
        }
        if (!filename) filename = result.availabilityId || "document";
        if (!/\.pdf$/i.test(filename)) filename += ".pdf";

        // Dry-run: the launch produced a downloadable PDF, so it's accessible;
        // record it and don't write the file.
        if (this.dryRun) {
          report.recordAvailable(retrieveUrl, "lti-pdf");
          return { handled: true, ok: true };
        }

        const buf = Buffer.from(result.base64, "base64");
        const filePath = path.join(dir, this.stripInvalid(filename));
        fs.writeFileSync(filePath, buf);
        report.record(filePath, retrieveUrl);
        return { handled: true, ok: true };
      }

      // HBS launch, but no downloadable PDF (e.g video / online reader only).
      return fail("no-pdf-form");
    } catch (e) {
      diag.error = e.message || String(e);
      return fail("exception");
    } finally {
      if (page) await page.close().catch(() => {});
    }
  },

  /**
   * Finds external links (anchors and iframes) within a content area and downloads
   * them: video-provider links (YouTube, Panopto, ...) via yt-dlp (mp4), everything
   * else as a plain file download.
   * @param {Page} page page to search on
   * @param {Array<object>} cookies cookies to authenticate video downloads with
   * @param {string} dir directory to download to
   * @param {string} contentSelector selector for the content container to scan
   * @returns {Promise<Array<string>>} array of URLs that could not be downloaded
   */
  async searchAndDownloadExternal(page, cookies, dir, contentSelector) {
    if (!contentSelector) return [];

    const { external, lti } = await page.evaluate((contentSelector) => {
      const host = location.hostname;
      const urls = [];
      document
        .querySelectorAll(`${contentSelector} a`)
        .forEach((a) => a.href && urls.push(a.href));
      document
        .querySelectorAll(`${contentSelector} iframe`)
        .forEach((f) => f.src && urls.push(f.src));

      const external = [];
      const lti = [];
      for (const u of [...new Set(urls)]) {
        let url;
        try {
          url = new URL(u);
        } catch (e) {
          continue;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;

        if (url.hostname !== host) {
          external.push(u);
        } else if (url.pathname.includes("/external_tools/")) {
          // Same-host Canvas LTI launch (e.g Harvard Business Publishing case).
          lti.push(u);
        }
      }
      return { external, lti };
    }, contentSelector);

    let problematic = [];
    for (let i = 0; i < external.length; i++) {
      const url = external[i];
      let hostname = "";
      try {
        hostname = new URL(url).hostname.toLowerCase();
      } catch (e) {
        problematic.push(url);
        report.recordFailure(url, "invalid URL", { destDir: dir });
        continue;
      }

      try {
        const isVideo = this.isVideoHost(hostname);
        const success = isVideo
          ? await this.downloadVideo(url, dir, cookies)
          : await this.downloadExternalResource(page.browser(), url, dir, i);
        if (!success) {
          problematic.push(url);
          report.recordFailure(
            url,
            this.describeUndownloadable(url, { video: isVideo }),
            { destDir: dir }
          );
        }
      } catch (e) {
        problematic.push(url);
        report.recordFailure(url, e.message || "download error", { destDir: dir });
      }
    }

    // LTI external-tool launches (e.g Harvard Business Publishing cases). For HBS
    // we perform the signed launch in the authenticated browser and submit the
    // "Download PDF" form to fetch the file. Anything we can't download (a
    // non-HBS tool, or an HBS item with no PDF) is surfaced so it can be opened
    // and saved manually (the Canvas URL performs the launch while signed in).
    for (const url of lti) {
      let ok = false;
      // Default to a host-aware explanation (e.g Panopto launches); downloadLtiPdf
      // overrides it with an HBS-specific reason when it recognizes the launch.
      let reason = this.describeUndownloadable(url, { lti: true });
      try {
        const r = await this.downloadLtiPdf(page.browser(), cookies, url, dir);
        ok = !!(r && r.handled && r.ok);
        if (r && r.reason) reason = r.reason;
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        problematic.push(url);
        report.recordFailure(url, reason, { destDir: dir });
      }
    }

    return problematic;
  },

  /**
   * Prints a message to the console
   * @param {string} type type of message
   * @param {string} name name of item being printed
   * @param {string} message message to print
   * @param {Number} indent number of indents to use
   * @param {any} additional additional information to print (e.g error stack trace)
   */
  // Optional sink for print(). When set (via setPrinter), every print() call is
  // forwarded to it instead of going straight to the console, so a front-end
  // (e.g. the Ink TUI) can render log lines itself. null = default console.
  printer: null,

  /**
   * Redirects print() output to `fn` (or back to the console when null).
   * @param {?function} fn receives a record { type, name, message, indent,
   *   additional, line } for each print() call.
   */
  setPrinter(fn) {
    this.printer = fn || null;
  },

  // Optional sink for download progress. When set (via setProgressSink), the
  // file/video downloaders report progress to it so a front-end can render a
  // bar. Each event: { scope: "file"|"video", phase: "start"|"progress"|"done",
  // name, received, total, percent, speed, eta, index, count }. null = ignored.
  progressSink: null,

  /** Routes download-progress events to `fn` (or disables them when null). */
  setProgressSink(fn) {
    this.progressSink = fn || null;
  },

  // When true (a --dry-run), no bytes are written to disk: pages, files and
  // videos are only probed for accessibility and recorded via `report`, so the
  // run surfaces which articles/artifacts are inaccessible without downloading
  // anything. Set/reset by runScrape (like printer/progressSink).
  dryRun: false,

  /** Turns dry-run mode on or off. */
  setDryRun(on) {
    this.dryRun = !!on;
  },

  /**
   * Captures a page as a PDF, or — in dry-run — probes the page's accessibility
   * and records it instead of writing anything. Every scraper that would save a
   * page PDF goes through here, so dry-run turns each into an article probe.
   * @param {Page} page a page opened via newPage (carries page.status)
   * @param {object} options puppeteer page.pdf() options (incl. the output path)
   * @param {string} [kind] short label for the dry-run report (default "page")
   */
  async capturePdf(page, options, kind = "page") {
    if (this.dryRun) {
      this.probePage(page, kind);
      return;
    }
    await page.pdf(options);
  },

  /**
   * Records a loaded page as an accessible/inaccessible "article" for the
   * dry-run report, based on the HTTP status newPage captured.
   * @param {Page} page a page opened via newPage (carries page.status)
   * @param {string} [kind] short label for the report
   */
  probePage(page, kind = "page") {
    let url = "";
    try {
      url = page.url();
    } catch (e) {
      // page may be closing; fall back to an empty url
    }
    const status = page.status;
    if (status && status !== 200) {
      report.recordFailure(url, this.describeHttpFailure(url, status));
    } else {
      report.recordAvailable(url, kind);
    }
  },

  /** Emits one download-progress event; never lets a UI error break a download. */
  emitProgress(evt) {
    if (!this.progressSink) return;
    try {
      this.progressSink(evt);
    } catch (e) {
      /* a failing progress sink must not abort the download */
    }
  },

  /**
   * Streams a fetch response body to `filePath`, reporting byte progress. Byte
   * counting on 'data' runs alongside the pipe (it doesn't consume the stream).
   * @param {object} response node-fetch response (with a readable `body`)
   * @param {string} filePath destination path
   * @param {string} name human-readable name for progress events
   * @param {string} [scope="file"] progress scope label
   */
  async streamToFile(response, filePath, name, scope = "file") {
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    let lastEmit = 0;
    this.emitProgress({ scope, phase: "start", name, received: 0, total });
    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(filePath);
      response.body.on("error", reject);
      response.body.on("data", (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 150) {
          lastEmit = now;
          this.emitProgress({
            scope,
            phase: "progress",
            name,
            received,
            total,
            percent: total ? (received / total) * 100 : null,
          });
        }
      });
      fileStream.on("error", reject);
      fileStream.on("finish", resolve);
      response.body.pipe(fileStream);
    });
    this.emitProgress({
      scope,
      phase: "done",
      name,
      received,
      total,
      percent: total ? 100 : null,
    });
  },

  print(type, name, message, indent = 0, additional = null) {
    const line = `[${type}]${"  ".repeat(indent)} ${name} | ${message}`;
    // Track every error so it can be written to errors.csv and resolved later.
    // Guarded so a bad record never breaks logging.
    if (type === "ERROR") {
      try {
        const isErr = additional instanceof Error;
        report.recordError({
          name,
          message,
          detail: this.describeErrorDetail(additional),
          // Capture the error class and full stack (file + line) so a row has
          // enough context for a developer/LLM to locate and fix the cause.
          errorType: isErr
            ? additional.name || (additional.constructor && additional.constructor.name) || "Error"
            : "",
          stack: isErr ? additional.stack || "" : "",
        });
      } catch (e) {
        // never let error tracking interfere with logging
      }
    }
    if (this.printer) {
      this.printer({ type, name, message, indent, additional, line });
      return;
    }
    console.log(line);
    if (additional) console.log(additional);
  },

  /**
   * Renders the `additional` argument of print() as the human-readable "detail"
   * for the errors CSV: an Error's message (the stack is captured separately),
   * or the stringified value.
   * @param {any} additional
   * @returns {string}
   */
  describeErrorDetail(additional) {
    if (additional == null) return "";
    if (additional instanceof Error) return additional.message || String(additional);
    return String(additional);
  },

  /**
   * Writes data to a file
   * @param {string} dir directory to write to
   * @param {string} filename name of file to write to
   * @param {any} data data to write
   */
  async writeFile(dir, filename, data) {
    if (this.dryRun) return; // dry-run writes nothing to disk
    const textStream = Readable.from(data);
    const fileStream = fs.createWriteStream(path.join(dir, filename));
    await textStream.pipe(fileStream);
  },

  types: {
    assignment: {
      s: "assignment",
      p: "assignments",
    },
    module: {
      s: "module",
      p: "modules",
    },
    quiz: {
      s: "quiz",
      p: "quizzes",
    },
  },

  /**
   * Returns a course's home-page type ("modules", "assignments", "wiki",
   * "syllabus", "feed", ...) from the Canvas API, or null if it can't be
   * determined. Canvas hides a content tab from the nav when the home page IS
   * that content (e.g. a Modules home hides the Modules tab); scrapeSections
   * uses this to tell a legitimate home redirect from a disabled tab. Cached
   * per course.
   * @param {string} courseUrl e.g "https://canvas.mit.edu/courses/38628"
   * @param {Array<object>} cookies session cookies
   * @returns {Promise<string|null>}
   */
  async getCourseDefaultView(courseUrl, cookies) {
    if (courseDefaultViewCache.has(courseUrl))
      return courseDefaultViewCache.get(courseUrl);
    let view = null;
    try {
      const apiUrl = courseUrl.replace("/courses/", "/api/v1/courses/");
      const cookieHeader = cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const res = await fetch(apiUrl, {
        headers: { Cookie: cookieHeader, Accept: "application/json" },
      });
      if (res.ok) {
        const course = await res.json();
        view = course.default_view || null;
      }
    } catch (e) {
      // Non-fatal: without it the guard just treats any redirect as a
      // disabled tab, which is the safe default.
    }
    courseDefaultViewCache.set(courseUrl, view);
    return view;
  },

  /**
   * Gets all sections from a page
   * @param {Page} page page to scrape from
   * @param {string} sectionSelector selector for sections
   * @param {string} headerSelector selector for section headers
   * @param {string} itemSelector selector for items in sections
   * @returns {Promise<Array<object>>} array of sections
   */
  async getSections(page, sectionSelector, headerSelector, itemSelector) {
    let sections = await page.evaluate(
      (sectionSelector, headerSelector, itemSelector) => {
        // get all sections
        return Array.from(document.querySelectorAll(sectionSelector)).map(
          (section) => {
            // get all links in the section
            let header = section.querySelector(headerSelector);
            let name = header ? header.innerText : "";
            let links = Array.from(section.querySelectorAll(itemSelector))
              .map((link) => {
                let url = link.href;
                let name = link.innerText;
                let grade;
                if (url.includes("/assignments/")) {
                  try {
                    grade =
                      link.parentNode.querySelector(".score-display").innerText;
                  } catch (e) {
                    grade = "NA";
                  }
                }

                return { name, url, grade };
              })
              .filter((a) => !a.url.includes("reviewee_id="));

            return { name, links };
          }
        );
      },
      sectionSelector,
      headerSelector,
      itemSelector
    );

    for (let section of sections) {
      section.name = this.stripInvalid(section.name);
      for (let link of section.links) {
        link.name = this.stripInvalid(link.name);
        if (link.grade) link.grade = this.stripInvalid(link.grade);
      }
    }

    return sections;
  },

  /**
   * Creates a directory, avoiding collisions with existing ones. Sanitized
   * names frequently repeat (e.g. several untitled sections, or two files with
   * the same name), and a bare mkdirSync throws EEXIST on the second. When the
   * desired path is taken, appends " (2)", " (3)", ... until a free name is
   * found. Missing parent directories are created as needed.
   * @param {string} desiredPath the directory path to create
   * @returns {string} the path actually created (may carry a " (n)" suffix)
   */
  mkUniqueDir(desiredPath) {
    // Dry-run writes nothing, so don't create (or uniquify) any directories;
    // just hand back the path callers use to build download destinations.
    if (this.dryRun) return desiredPath;
    const parent = path.dirname(desiredPath);
    const base = path.basename(desiredPath);
    fs.mkdirSync(parent, { recursive: true });
    let candidate = desiredPath;
    let n = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(parent, `${base} (${n})`);
      n++;
    }
    fs.mkdirSync(candidate);
    return candidate;
  },

  /**
   * Scrapes sections of a course
   * @param {Browser} browser puppeteer browser
   * @param {Object} cookies cookies to use
   * @param {string} url url to course homepage
   * @param {string} dir directory to save to
   * @param {string} type type of page (e.g module, assignment)
   * @param {Function} gettingFunction function to get sections
   * @param {Function} scrapingFunction function to scrape a specific item in a section
   */
  async scrapeSections(
    browser,
    cookies,
    url,
    dir,
    type,
    gettingFunction,
    scrapingFunction
  ) {
    console.log(`=== SCRAPING ${this.types[type].p.toUpperCase()} ===`);
    const page = await this.newPage(
      browser,
      cookies,
      `${url}/${this.types[type].p}`
    );
    if (page.status !== 200) {
      this.print(
        "ERROR",
        this.types[type].p.toUpperCase(),
        `Could not load ${this.types[type].p} page. Skipping...`,
        0,
        http.STATUS_CODES[page.status]
      );
      await page.close().catch(() => {});
      return;
    }

    // A disabled course tab (e.g. Quizzes turned off) makes Canvas redirect the
    // request to another page — usually the course home — which still returns
    // 200. Without this guard the generic selectors would scrape that other
    // page's content (e.g. Modules) as if it were this section.
    //
    // A redirect is only legitimate when the tab lands on the course home AND
    // the home is configured to display this same content (Canvas hides, say,
    // the Modules tab when the home page IS the modules list). Any other
    // redirect means the tab is disabled, so skip it.
    let finalPath;
    try {
      finalPath = new URL(page.url()).pathname.replace(/\/+$/, "");
    } catch {
      finalPath = page.url();
    }
    if (!finalPath.endsWith(`/${this.types[type].p}`)) {
      let courseHomePath;
      try {
        courseHomePath = new URL(url).pathname.replace(/\/+$/, "");
      } catch {
        courseHomePath = url;
      }
      // default_view values that mean "the home page is this section".
      const homeView = { module: "modules", assignment: "assignments" }[type];
      const homeShowsThisSection =
        finalPath === courseHomePath &&
        homeView &&
        (await this.getCourseDefaultView(url, cookies)) === homeView;
      if (!homeShowsThisSection) {
        this.print(
          "WARNING",
          this.types[type].p.toUpperCase(),
          `The ${this.types[type].p} tab is disabled or redirected (landed on ${page.url()}); skipping.`,
          0
        );
        await page.close().catch(() => {});
        return;
      }
    }

    // Only now that we know the tab is real do we create its output directory,
    // so a disabled/redirected tab doesn't leave an empty folder behind. (A
    // dry-run writes nothing, so it skips this.)
    if (!this.dryRun) {
      fs.mkdirSync(`${dir}/${this.types[type].p.toUpperCase()}`, {
        recursive: true,
      });
    }

    if (type === "assignment") {
      let submissionsURL = `${url.replace(
        "/courses",
        "/api/v1/courses"
      )}/students/submissions?per_page=50`;
      try {
        await page.waitForResponse(submissionsURL, { timeout: 5000 });
      } catch (e) {
        console.log(
          "[WARNING] COULD NOT GET SUBMISSIONS REQUEST, CONTINUING ANYWAY..."
        );
      }
    }

    await this.capturePdf(page, {
      path: `${dir}/${this.types[type].p.toUpperCase()}/${this.types[
        type
      ].p.toUpperCase()}.pdf`,
      format: "Letter",
    });

    const sections = await gettingFunction(page);

    let pSections = [];
    for (const section of sections) {
      try {
        let pLinks = [];
        this.print(
          "NOTE",
          `${this.types[type].s.toUpperCase()} SECTION '${section.name}'`,
          `STARTING SCRAPING`,
          0
        );
        // Section names are sanitized and can collide (e.g. several
        // "untitled" sections). Create a unique directory and adopt its name
        // so the scrapingFunction below writes into the same folder.
        const sectionDir = this.mkUniqueDir(
          `${dir}/${this.types[type].p.toUpperCase()}/${section.name}`
        );
        section.name = path.basename(sectionDir);
        for (const link of section.links) {
          try {
            let pDownloads = await scrapingFunction(
              browser,
              cookies,
              dir,
              section.name,
              link
            );
            if (pDownloads.length > 0)
              pLinks.push({ name: link.name, links: pDownloads });
          } catch (e) {
            this.print(
              "ERROR",
              `${this.types[type].s.toUpperCase()} '${link.name}'`,
              `COULD NOT SCRAPE`,
              1,
              e
            );
          }
        }
        if (pLinks.length > 0)
          pSections.push({ name: section.name, links: pLinks });
      } catch (e) {
        this.print(
          "ERROR",
          `${this.types[type].s.toUpperCase()} SECTION '${section.name}'`,
          `COULD NOT SCRAPE`,
          0,
          e
        );
      }
    }

    try {
      this.printSummary(sections, pSections, type);
    } catch (e) {
      this.print(
        "ERROR",
        `${this.types[type].p.toUpperCase()} SUMMARY`,
        `COULD NOT PRINT`,
        0,
        e
      );
    }

    await page.close().catch(() => {});
  },

  /**
   * prints a summary of scraping results by section
   * @param {Array<Object>} sections
   * @param {Array<Object>} pSections
   * @param {string} type
   */
  printSummary(sections, pSections, type) {
    console.log(`--- ${this.types[type].p.toUpperCase()} SCRAPING SUMMARY ---`);
    console.log(
      `[NOTE] TOTAL ${this.types[type].s.toUpperCase()} SECTIONS: ${
        sections.length
      }`
    );
    let itemCount = sections
      .map((section) => {
        return section.links.length;
      })
      .reduce((a, b) => a + b, 0);
    console.log(
      `[NOTE] TOTAL ${this.types[type].p.toUpperCase()}: ${itemCount}`
    );

    if (pSections.length > 0) {
      console.log("[WARNING] Some files failed to download...");
      for (let section of pSections) {
        console.log(`  ${section.name}`);
        for (let link of section.links) {
          console.log(`    ${link.name}`);
          for (let file of link.links) {
            console.log(`      ${file}`);
          }
        }
      }
    }
  },
};

export default exported;
