import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import os from "os";
import http from "http";
import { spawn } from "child_process";
import { Browser, Page } from "puppeteer";
import { Readable } from "stream";

import report from "./report.js";
import manifest from "./manifest.js";
import { detectPaywall, collectSignals, siteFor, paywallReason } from "./paywall.js";
import { cookiesForUrl } from "../core/cookieJar.js";
import { detectBotWall, botWallReason, siteHost } from "./botwall.js";
import { extractMarkdown } from "./articleMarkdown.js";
import waits from "./waits.js";
import { resolveTimeouts } from "./timeouts.js";

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
// Pages opened by openIsolatedTab -> the throwaway browser context they live in.
const isolatedContexts = new WeakMap();

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
        page = await this.openTab(browser);
        if (cookies && cookies.length) await page.setCookie(...cookies);
        const response = await waits.track(`${this.shortUrl(url)} to load`, this.pageLoadTimeoutMs, () =>
          page.goto(url, { timeout: this.pageLoadTimeoutMs })
        );
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
    return /Target\.createTarget timed out|Network\.enable timed out|protocolTimeout|Requesting main frame too early|Navigation timeout|Runtime\.callFunctionOn timed out|Protocol error|Target closed|Session closed|socket hang up|net::ERR_/i.test(
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
    // Mark this asset referenced this run (whether it downloads, skips, or
    // fails) so a still-listed but now-locked item isn't later mistaken for one
    // whose source was removed from the course.
    manifest.markSeen(url);
    // Resume: if a complete copy is already on disk (per the course manifest),
    // skip the fetch entirely. --force bypasses this. Dry-run ignores the
    // manifest — it probes accessibility rather than trusting prior state.
    if (!this.dryRun) {
      const existing = manifest.completePath(url);
      if (existing) {
        report.record(existing, url);
        this.print("NOTE", "SKIP", `already downloaded ${path.basename(existing)}`, 1);
        return true;
      }
    }

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
    if (ok) {
      report.record(filePath, url);
      manifest.record(url, filePath, {
        bytes: Number(response.headers.get("content-length")) || 0,
        etag: response.headers.get("etag") || "",
      });
    } else {
      report.recordFailure(url, "no file returned (missing content-disposition)");
    }
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
   * @param {string} domain e.g "<canvas url>"
   * @param {Array<object>} cookies session cookies
   * @param {Browser} [browser] puppeteer browser (needed for the HTML fallback)
   * @returns {Promise<Array<{id: (string|number), name: string}>>}
   */
  async listCourses(domain, cookies, browser) {
    const cookieHeader = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    const courses = [];
    this.courseListError = null;
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
        this.courseListError = `could not reach ${domain} (${e.message})`;
        break;
      }
      if (!response.ok) {
        this.courseListError =
          response.status === 401 || response.status === 403
            ? "Canvas rejected the saved cookies (session expired?)"
            : `Canvas course API returned HTTP ${response.status}`;
        break;
      }

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
   * @param {string} domain e.g "<canvas url>"
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
   * Whether a hostname is study.net or a subdomain of it. Study.Net material
   * links embedded in Canvas content (e.g …/remote/view/…) can't be fetched by a
   * plain external download — they require the study.net session that only the
   * signed LTI launch establishes — so they're handled by the -s Study.Net
   * Materials scraper instead of the generic external-resource path.
   * @param {string} hostname lowercase hostname
   * @returns {boolean}
   */
  isStudyNetHost(hostname) {
    return hostname === "study.net" || hostname.endsWith(".study.net");
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
    const file = path.join(os.tmpdir(), `canvas-scraper-cookies-${process.pid}.txt`);
    ytDlpCookieFile = this.writeNetscapeCookieFile(cookies, file) || "";
    return ytDlpCookieFile || null;
  },

  /**
   * Renders puppeteer-style cookies as a Netscape HTTP Cookie File (the format
   * yt-dlp's --cookies reads).
   * @param {Array<object>} cookies puppeteer-style cookies (name, value, domain, ...)
   * @returns {string} the file contents
   */
  netscapeCookieText(cookies) {
    const lines = ["# Netscape HTTP Cookie File"];
    for (const c of cookies || []) {
      if (!c.name || !c.domain) continue;
      const domain = c.domain;
      const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
      const cookiePath = c.path || "/";
      const secure = c.secure ? "TRUE" : "FALSE";
      // 0 = session cookie; yt-dlp accepts these.
      const expiry = Math.floor(c.expires && c.expires > 0 ? c.expires : 0);
      lines.push(
        [domain, includeSub, cookiePath, secure, expiry, c.name, c.value].join("\t")
      );
    }
    return lines.join("\n") + "\n";
  },

  /**
   * Writes cookies to `file` as a Netscape cookie file (owner-only perms, since
   * it holds session tokens). Returns the path, or null if it couldn't be written.
   * @param {Array<object>} cookies puppeteer-style cookies
   * @param {string} file destination path
   * @returns {string|null}
   */
  writeNetscapeCookieFile(cookies, file) {
    try {
      fs.writeFileSync(file, this.netscapeCookieText(cookies), { mode: 0o600 });
      return file;
    } catch (e) {
      this.print("WARNING", "YT-DLP", "Could not build cookie file for yt-dlp", 0, e);
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
    // Mark referenced this run (see downloadFile), then resume-skip if a
    // complete copy is already on disk.
    manifest.markSeen(url);
    if (!this.dryRun) {
      const existing = manifest.completePath(url);
      if (existing) {
        report.record(existing, url);
        this.print("NOTE", "SKIP", `already downloaded ${path.basename(existing)}`, 1);
        return true;
      }
    }

    let response;
    try {
      response = await this.fetchWithTimeout(url, { method: "GET", redirect: "follow" });
    } catch (e) {
      if (e && e.code === "ETIMEDOUT") {
        this.print("WARNING", "TIMEOUT", e.message, 1, url);
        report.recordFailure(url, `timed out: ${e.message}`, { destDir: dir });
      }
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
    manifest.record(url, filePath, {
      bytes: Number(response.headers.get("content-length")) || 0,
      etag: response.headers.get("etag") || "",
    });
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
      response = await this.fetchWithTimeout(url, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": BROWSER_UA },
      });
    } catch (e) {
      // A site that holds the connection open without answering (common with
      // bot protection) used to hang the whole run here. Say so, then let the
      // browser try it below — it has its own navigation timeout.
      if (e && e.code === "ETIMEDOUT") this.print("WARNING", "TIMEOUT", `${e.message}; trying it in the browser`, 1, url);
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
    // Its site already blocked the automated browser in this run.
    const site = this.blockedSiteFor(url);
    if (site) {
      const reason = this.blockedReason(url);
      this.print("NOTE", "SKIP", `${site.host} blocked the automated browser earlier in this run — skipping`, 1, url);
      report.recordFailure(url, reason, { destDir: dir });
      return false;
    }
    let page;
    try {
      page = await this.openIsolatedTab(browser);
      // Send the user's saved cookies for this article's own site (e.g. an
      // imported Economist session), so subscribed articles load in full.
      const siteCookies = cookiesForUrl(this.cookieJar, url);
      if (siteCookies.length) await page.setCookie(...siteCookies).catch(() => {});
      await page.setViewport({ width: 1280, height: 900 });
      // Present a normal browser UA; the default headless UA ("HeadlessChrome")
      // is blocked by some sites (e.g nytimes.com).
      await page.setUserAgent(BROWSER_UA).catch(() => {});
      // Archive what a reader sees (screen styles), not the print stylesheet.
      await page.emulateMediaType("screen").catch(() => {});
      // Render whatever loads; don't fail the whole thing on a slow idle timeout.
      const navResponse = await waits
        .track(`${siteHost(url) || url} to load`, this.articleLoadTimeoutMs, () =>
          page.goto(url, { waitUntil: "networkidle2", timeout: this.articleLoadTimeoutMs })
        )
        .catch(() => null);

      let name = "";
      try {
        name = ((await page.title()) || "").trim();
      } catch (e) {
        // ignore
      }

      // Detect a blocked render. Bot-walled sites (The Economist, Cloudflare,
      // DataDome, ...) serve an empty page or a recognizable interstitial
      // ("Access is temporarily restricted", "Are you a robot?", a captcha).
      // Archiving those produces a junk PDF that masquerades as the article, so
      // warn on the console and record the reason for report-skipped.csv (and
      // the dry-run report). We never try to get past the wall.
      let bodyText = "";
      try {
        bodyText = await page.evaluate(
          () => (document.body && document.body.innerText) || ""
        );
      } catch (e) {
        // ignore
      }
      const wall = detectBotWall({ title: name, text: bodyText });
      if (wall.blocked) {
        const reason = botWallReason(url, wall);
        this.print("WARNING", "BLOCKED", reason, 1, url);
        report.recordFailure(url, reason, { destDir: dir });
        this.rememberBlocked(url, reason);
        if (!this.blockedSiteFor(url)) {
          this.print(
            "WARNING",
            "BLOCKED",
            `skipping other ${siteHost(url)} links for the rest of this run`,
            1
          );
        }
        this.rememberBlockedSite(url, reason);
        report.recordDiagnostic({
          kind: "bot-wall",
          url,
          finalUrl: page.url(),
          status: navResponse ? navResponse.status() : 0,
          title: name,
          wall: wall.kind,
          match: wall.match,
        });
        return false;
      }

      // Paywall check: a subscribe/login teaser renders fine and passes the bot
      // wall test above, but isn't the article. Report it for follow-up (library
      // login or manual import) instead of archiving the teaser as a success.
      let paywall = { paywalled: false };
      try {
        const site = siteFor(url);
        const signals = await page.evaluate(collectSignals, site ? site.selectors : []);
        paywall = detectPaywall({
          url,
          finalUrl: page.url(),
          status: navResponse && navResponse.status(),
          signals,
        });
      } catch (e) {
        // detection is best-effort; fall through and archive as before
      }
      if (paywall.paywalled) {
        const reason = paywallReason(paywall, {
          url,
          hasCookies: cookiesForUrl(this.cookieJar, url).length > 0,
        });
        this.print("WARNING", "PAYWALL", reason, 1, url);
        report.recordFailure(url, reason, { destDir: dir });
        this.rememberBlocked(url, reason);
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

      // Companion Markdown copy of the article text (best-effort).
      try {
        const { title, markdown } = await page.evaluate(extractMarkdown);
        if (markdown.length >= 200) {
          const mdPath = filePath.replace(/\.pdf$/i, ".md");
          const header = `# ${title || name.replace(/\.pdf$/i, "")}\n\nSource: ${url}\n\n`;
          fs.writeFileSync(mdPath, header + markdown + "\n");
          report.record(mdPath, url);
        }
      } catch (e) {
        // the PDF is the primary artifact; a markdown failure is not an error
      }
      return true;
    } catch (e) {
      // Chrome died: that's not this article's fault. Let it propagate so the
      // course is relaunched and resumed, rather than reporting every remaining
      // link as undownloadable.
      if (this.browserGone(browser)) throw e;
      return false;
    } finally {
      await this.closeTab(page).catch(() => {});
    }
  },

  /** Whether a puppeteer browser has disconnected (crashed or was killed). */
  browserGone(browser) {
    return !!browser && typeof browser.isConnected === "function" && !browser.isConnected();
  },

  /**
   * Probes a video for accessibility with yt-dlp's --simulate (used by --dry-run):
   * resolves the video/playlist and its formats without downloading any media.
   * Records the result via `report` and returns whether it looks accessible.
   * @param {string} url video URL (viewer/embed/watch/folder page)
   * @param {Array<object>} [cookies] cookies to authenticate with
   * @returns {Promise<boolean>} whether the video appears accessible
   */
  async probeVideo(url, cookies, opts = {}) {
    const args = ["--simulate", "--no-warnings", "--quiet"];
    if (this.videoUrlKind(url) === "single") args.push("--no-playlist");
    const cookieFile = opts.cookieFile || this.getYtDlpCookieFile(cookies);
    if (cookieFile) args.push("--cookies", cookieFile);
    if (opts.referer) args.push("--referer", opts.referer);
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
   * @param {object} [opts]
   * @param {string} [opts.cookieFile] a Netscape cookie file to use instead of
   *   the one built from `cookies` (e.g. a provider session captured mid-run)
   * @param {string} [opts.referer] Referer header to send (some CDNs require it)
   * @param {string} [opts.filename] output basename (no extension) instead of
   *   yt-dlp's %(title)s — for direct media URLs whose "title" is meaningless
   * @returns {Promise<boolean>} whether the video was downloaded successfully
   */
  async downloadVideo(url, dir, cookies, opts = {}) {
    // Dry-run: ask yt-dlp to --simulate the download (resolve the video and its
    // formats without fetching any media) so we learn whether it's accessible
    // without downloading gigabytes.
    if (this.dryRun) return this.probeVideo(url, cookies, opts);

    const kind = this.videoUrlKind(url);
    // Use an absolute output path: on Windows yt-dlp only applies extended-length
    // (\\?\) path handling to absolute paths, so a relative -o would hit the
    // 260-char MAX_PATH limit on deep course/module folders.
    const absDir = path.resolve(dir);
    // Folders/playlists nest their videos under a subfolder named for the
    // playlist; single sessions land flat in `dir`.
    // A caller-chosen filename has "%" escaped so yt-dlp doesn't treat it as a
    // template field.
    const outTemplate = opts.filename
      ? path.join(absDir, `${opts.filename.replace(/%/g, "%%")}.%(ext)s`)
      : kind === "playlist"
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

    // Resume: record every downloaded video/playlist entry in a per-course
    // archive and skip anything already in it on a re-run, and never overwrite a
    // file already on disk. A --fresh run wipes the course folder (archive and
    // all), so it re-downloads. Kept at the course root (falling back to the
    // download dir) so one archive dedupes a video linked from several places.
    const archiveDir =
      manifest.enabled && manifest.courseDir ? manifest.courseDir : absDir;
    args.push(
      "--no-overwrites",
      "--download-archive",
      path.join(path.resolve(archiveDir), ".yt-dlp-archive.txt")
    );

    const cookieFile = opts.cookieFile || this.getYtDlpCookieFile(cookies);
    if (cookieFile) args.push("--cookies", cookieFile);
    if (opts.referer) args.push("--referer", opts.referer);

    // Optional post-download transcription: run the configured command on each
    // finished file. Rather than yt-dlp's --exec (opaque), we run it ourselves
    // after the download so we can report transcription progress.
    let transcribeCmd = "";
    if (process.env.transcribe === "true") {
      try {
        transcribeCmd = process.env.transcribeCommand || "";
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

    // Snapshot the media already present so we can tell, after a clean (code 0)
    // exit, whether yt-dlp actually produced any video. A login-gated provider
    // (e.g. Panopto without valid cookies) can resolve an empty playlist and
    // exit 0 having downloaded nothing — which we must report, not swallow.
    const VIDEO_MEDIA_RE = /\.(mp4|m4a|mkv|webm|mp3|wav)$/i;
    const mediaBefore = new Set(
      this.listFilesRecursive(absDir).filter((f) => VIDEO_MEDIA_RE.test(f))
    );

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
      // Set when yt-dlp reports skipping an item it already has in the download
      // archive — a clean "nothing new" on a re-run, not a failure.
      let archiveSkipped = false;

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
          if (
            line.includes("has already been recorded in the archive") ||
            line.includes("has already been downloaded")
          ) {
            archiveSkipped = true;
          }
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
        if (code === 0) report.recordNewFiles(absDir, before, url);
        const newMediaCount =
          code === 0
            ? this.listFilesRecursive(absDir).filter(
                (f) => VIDEO_MEDIA_RE.test(f) && !mediaBefore.has(f)
              ).length
            : 0;
        // ENOENT is handled by the 'error' handler above (no 'close' with 0).
        const outcome = this.videoOutcome({
          code,
          newMediaCount,
          archiveSkipped,
          stderr,
          url,
        });
        if (outcome.ok) return resolve(true);
        this.print("WARNING", "YT-DLP", outcome.message, 0, outcome.detail || null);
        resolve(false);
      });
    });
  },

  /**
   * Classifies a yt-dlp run so silent failures get surfaced. A non-zero exit is
   * a failure; a clean exit that produced no media and skipped nothing via the
   * download archive is treated as a failure too — that's the tell-tale of a
   * login/cookie wall (e.g. Panopto), which would otherwise look like success.
   * @param {object} r
   * @param {number} r.code yt-dlp exit code
   * @param {number} r.newMediaCount media files produced this run
   * @param {boolean} r.archiveSkipped yt-dlp skipped an already-archived item
   * @param {string} r.stderr captured stderr
   * @param {string} r.url the video/folder URL
   * @returns {{ok: boolean, empty?: boolean, message?: string, detail?: string}}
   */
  videoOutcome({ code, newMediaCount, archiveSkipped, stderr, url }) {
    const detail = (stderr || "").trim() || null;
    if (code !== 0) {
      return {
        ok: false,
        message: `Could not download ${url}`,
        detail: detail || `yt-dlp exited with code ${code}`,
      };
    }
    if (newMediaCount === 0 && !archiveSkipped) {
      return {
        ok: false,
        empty: true,
        message:
          `No video was downloaded from ${url}. This usually means the video ` +
          `host requires a login your cookies don't cover (most often ` +
          `Panopto). Make sure your cookies file includes a current session ` +
          `for the video host, then re-run.`,
        detail,
      };
    }
    return { ok: true };
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
      const withDir = cmd.replaceAll("{dir}", this.shellQuote(path.dirname(file)));
      const fullCmd = withDir.includes("{}")
        ? withDir.replaceAll("{}", quoted)
        : `${withDir} ${quoted}`;

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

      // Study.Net viewer links embedded in Canvas content (e.g …/remote/view/…)
      // can't be fetched here: they need the study.net session that only the
      // signed LTI launch establishes. The -s Study.Net Materials scraper opens
      // that tab and downloads these same materials into STUDYNET/. Record a
      // pointer to that flow so the item is accounted for, but don't count it as
      // a hard download failure — it's delivered by -s, not missing.
      if (this.isStudyNetHost(hostname)) {
        report.recordFailure(
          url,
          "Study.Net material — download via the Study.Net Materials tab (run with -s)",
          { destDir: dir }
        );
        continue;
      }

      // Already found paywalled or bot-blocked earlier in this run (the same
      // reading linked from an assignment and a module, or a course resumed
      // after a Chrome restart). Loading it again can't change the answer and
      // heavy news pages are what wear Chrome down, so reuse the result.
      const known = this.blockedReason(url);
      if (known) {
        const site = this.blockedThisRun.has(url) ? null : this.blockedSiteFor(url);
        this.print(
          "NOTE",
          "SKIP",
          site
            ? `${site.host} blocked the automated browser earlier in this run — skipping`
            : `already checked this run — ${known}`,
          1,
          url
        );
        problematic.push(url);
        report.recordFailure(url, known, { destDir: dir });
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
        // See archiveWebpageAsPdf: a dead browser is a run-level fault.
        if (this.browserGone(page.browser())) throw e;
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

  // When true (a --fresh run), each course folder is wiped and rebuilt from
  // scratch before scraping. The default (false) reconciles in place: a re-run
  // keeps whatever is already on disk and only re-downloads what's missing or
  // incomplete, so it's safe to run the scrape repeatedly. Set/reset by
  // runScrape (like dryRun).
  fresh: false,

  /** Turns fresh (wipe-and-rebuild) mode on or off. */
  setFresh(on) {
    this.fresh = !!on;
  },

  // Backstop for opening a tab. Chrome can be slow to create targets under load
  // (see launchBrowser's protocolTimeout), so this is generous; the common
  // failure — Chrome killed or crashed mid-open — is caught at once via the
  // browser's "disconnected" event instead.
  openTabTimeoutMs: 300000,

  // The rest of the timeouts (see scrapers/timeouts.js; set from config.json
  // "timeouts" by setTimeouts()).
  protocolTimeoutMs: 300000,
  pageLoadTimeoutMs: 60000,
  articleLoadTimeoutMs: 30000,
  chromeCheckTimeoutMs: 30000,

  /**
   * Applies config.json "timeouts" (seconds) over the defaults.
   * @param {object} config the whole config.json object
   * @returns {string[]} warnings about settings that were ignored
   */
  setTimeouts(config) {
    const { ms, warnings } = resolveTimeouts(config);
    this.protocolTimeoutMs = ms.chromeRequest;
    this.openTabTimeoutMs = ms.openTab;
    this.pageLoadTimeoutMs = ms.pageLoad;
    this.articleLoadTimeoutMs = ms.articleLoad;
    this.externalResponseTimeoutMs = ms.siteResponse;
    this.streamIdleTimeoutMs = ms.downloadStall;
    this.chromeCheckTimeoutMs = ms.chromeCheck;
    waits.idleLimitMs = ms.chromeRequest;
    return warnings;
  },

  /** "https://www.example.com/a/very/long/path?x=1" -> "www.example.com/a/very/long/pa…" */
  shortUrl(url, max = 60) {
    let s = String(url || "");
    try {
      const u = new URL(s);
      s = u.hostname + u.pathname;
    } catch (e) {
      /* keep as is */
    }
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  },

  /**
   * browser.newPage() that can't hang forever.
   *
   * Puppeteer's newPage() waits for the new tab to finish initializing, and that
   * wait has no timeout. If initialization fails (e.g "Network.enable timed
   * out", which surfaces as an unhandled rejection) or Chrome is killed while a
   * tab is opening, the call never settles and the whole scrape stalls. This
   * rejects as soon as the browser disconnects, or after `ms`, with a message
   * runScrape recognizes as a browser fault (so it relaunches and resumes). A
   * tab that finishes opening after we gave up is closed.
   * @param {import("puppeteer").Browser} browser
   * @param {number} [ms] backstop timeout
   * @returns {Promise<import("puppeteer").Page>}
   */
  openTab(browser, ms = this.openTabTimeoutMs, open = (b) => b.newPage()) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const waitId = waits.begin("Chrome to open a tab", ms);
      const off = () => {
        clearTimeout(timer);
        waits.end(waitId);
        if (typeof browser.off === "function") browser.off("disconnected", onDisconnected);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        off();
        reject(err);
      };
      const onDisconnected = () =>
        fail(new Error("Opening a tab failed: Browser has disconnected"));

      if (typeof browser.isConnected === "function" && !browser.isConnected()) {
        onDisconnected();
        return;
      }
      browser.on("disconnected", onDisconnected);
      timer = setTimeout(
        () => fail(new Error(`Opening a tab timed out after ${Math.round(ms / 1000)}s`)),
        ms
      );
      Promise.resolve()
        .then(() => open(browser))
        .then(
          (page) => {
            if (settled) {
              // We already gave up on this tab; don't leak it.
              this.closeTab(page).catch(() => {});
              return;
            }
            settled = true;
            off();
            resolve(page);
          },
          (err) => fail(err)
        );
    });
  },

  /**
   * Like openTab, but in a throwaway browser context (its own cookies, storage,
   * service workers and helper frames). Closing the tab with closeTab() closes
   * the whole context, so everything the site started goes with it.
   *
   * Used for outside articles: heavy news sites leave service workers, worker
   * frames and other targets running after their tab closes, and over a long
   * run those pile up until Chrome stops answering and has to be restarted.
   * @param {import("puppeteer").Browser} browser
   * @param {number} [ms] backstop timeout
   * @returns {Promise<import("puppeteer").Page>}
   */
  openIsolatedTab(browser, ms = this.openTabTimeoutMs) {
    return this.openTab(browser, ms, async (b) => {
      const create =
        typeof b.createBrowserContext === "function"
          ? () => b.createBrowserContext()
          : typeof b.createIncognitoBrowserContext === "function"
          ? () => b.createIncognitoBrowserContext()
          : null;
      if (!create) return b.newPage();
      const context = await create();
      try {
        const page = await context.newPage();
        isolatedContexts.set(page, context);
        return page;
      } catch (e) {
        await context.close().catch(() => {});
        throw e;
      }
    });
  },

  /**
   * Closes a tab from openTab/openIsolatedTab; for an isolated tab, closes its
   * whole browser context too.
   * @param {import("puppeteer").Page} page
   */
  async closeTab(page) {
    if (!page) return;
    const context = isolatedContexts.get(page);
    isolatedContexts.delete(page);
    if (context) {
      await context.close().catch(() => {});
      return;
    }
    await page.close().catch(() => {});
  },

  // Outside links found paywalled or bot-blocked in this run: url -> reason.
  // Kept across Chrome restarts; runScrape clears it at the start of a run.
  blockedThisRun: new Map(),

  /** Remembers that `url` was paywalled or bot-blocked in this run. */
  rememberBlocked(url, reason) {
    if (url && reason) this.blockedThisRun.set(url, reason);
  },

  // Sites that blocked the automated browser in this run: host -> {reason,
  // firstUrl}. A bot wall is site-wide, so the site's other links are skipped
  // for the rest of the run instead of being loaded only to hit the same wall.
  blockedSites: new Map(),

  /** Remembers that `url`'s site blocked the automated browser. */
  rememberBlockedSite(url, reason) {
    const host = siteHost(url);
    if (host && !this.blockedSites.has(host)) this.blockedSites.set(host, { reason, firstUrl: url });
  },

  /**
   * The blocked site `url` belongs to (the same host or a subdomain of it), or
   * null.
   * @returns {null | {host: string, reason: string, firstUrl: string}}
   */
  blockedSiteFor(url) {
    const host = siteHost(url);
    if (!host) return null;
    for (const [blocked, info] of this.blockedSites) {
      if (host === blocked || host.endsWith(`.${blocked}`)) return { host: blocked, ...info };
    }
    return null;
  },

  /**
   * Why `url` can be skipped: it was found paywalled or bot-blocked earlier in
   * this run, or its site blocked the automated browser. "" if neither.
   */
  blockedReason(url) {
    const known = this.blockedThisRun.get(url);
    if (known) return known;
    const site = this.blockedSiteFor(url);
    if (!site) return "";
    return (
      `bot-blocked: ${site.host} blocked the automated browser earlier in this run ` +
      `(${this.shortUrl(site.firstUrl)}), so its other links were skipped — open it in your ` +
      "own browser, save it as a PDF, and add it with `canvas-scraper import`"
    );
  },

  /** Forgets all remembered outcomes (start of a new run). */
  resetBlocked() {
    this.blockedThisRun.clear();
    this.blockedSites.clear();
  },

  /**
   * Whether Chrome still answers a trivial request within `ms`. Used to tell a
   * stray timed-out request (Chrome fine) from a Chrome that has hung.
   * @param {import("puppeteer").Browser} browser
   * @param {number} [ms]
   * @returns {Promise<boolean>}
   */
  async browserResponds(browser, ms = this.chromeCheckTimeoutMs) {
    if (!browser || this.browserGone(browser)) return false;
    let timer;
    const waitId = waits.begin("Chrome to answer a health check", ms);
    try {
      return await Promise.race([
        Promise.resolve(browser.version()).then(() => true, () => false),
        new Promise((r) => (timer = setTimeout(() => r(false), ms))),
      ]);
    } finally {
      clearTimeout(timer);
      waits.end(waitId);
    }
  },

  /**
   * A promise that rejects with "Browser has disconnected" when Chrome goes
   * away (at once if it already has), plus cancel() to stop listening.
   * @param {import("puppeteer").Browser} browser
   * @returns {{promise: Promise<never>, cancel: () => void}}
   */
  untilDisconnected(browser) {
    let onDisconnected = () => {};
    const promise = new Promise((_, reject) => {
      onDisconnected = () => reject(new Error("Browser has disconnected"));
      if (this.browserGone(browser)) onDisconnected();
      else browser.on("disconnected", onDisconnected);
    });
    promise.catch(() => {}); // only matters while someone races it
    return {
      promise,
      cancel: () => {
        if (typeof browser.off === "function") browser.off("disconnected", onDisconnected);
      },
    };
  },

  // How long an outside site gets to start responding before we give up on a
  // request (node-fetch has no default timeout, so one site that holds the
  // connection open — e.g. behind bot protection — could stall the whole run).
  externalResponseTimeoutMs: 30000,

  // How long a download may go without receiving any data before it's treated
  // as stalled and abandoned (see streamToFile).
  streamIdleTimeoutMs: 60000,

  /**
   * node-fetch with a deadline for the response headers. The timer is cleared
   * once headers arrive, so a large body can take as long as it needs (the
   * stall timeout in streamToFile covers a body that stops arriving).
   * @param {string} url
   * @param {object} [options] node-fetch options
   * @param {number} [ms] deadline in milliseconds
   * @returns {Promise<object>} the response
   * @throws {Error} with code "ETIMEDOUT" when the deadline passes
   */
  async fetchWithTimeout(url, options = {}, ms = this.externalResponseTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const waitId = waits.begin(`${this.shortUrl(url)} to respond`, ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
      if (e && e.name === "AbortError") {
        let host = url;
        try {
          host = new URL(url).hostname;
        } catch (err) {
          /* keep the raw url */
        }
        const err = new Error(`no response from ${host} within ${Math.round(ms / 1000)}s`);
        err.code = "ETIMEDOUT";
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      waits.end(waitId);
    }
  },

  // The run's cookie jar, so pages opened outside a Canvas session (external
  // articles) can be given the cookies for their own site. Set/reset by
  // runScrape (like dryRun).
  cookieJar: [],

  /** Sets the cookies available to external-article fetches. */
  setCookieJar(cookies) {
    this.cookieJar = Array.isArray(cookies) ? cookies : [];
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
    // Write to a sibling ".part" file and rename into place only once the body
    // has fully arrived. An interrupted run (dropped connection, Ctrl-C, crash)
    // then leaves a leftover ".part" — never a truncated file at the real path
    // that a resumed run would mistake for a complete download.
    const tmpPath = filePath + ".part";
    const idleMs = this.streamIdleTimeoutMs;
    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(tmpPath);
      let idle = null;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        clearTimeout(idle);
        // Best-effort cleanup so a failed download doesn't strand a ".part".
        try {
          response.body.unpipe(fileStream);
          response.body.destroy();
        } catch (e) {
          /* ignore */
        }
        try {
          fileStream.destroy();
        } catch (e) {
          /* ignore */
        }
        fs.rm(tmpPath, { force: true }, () => reject(err));
      };
      // A server that stops sending mid-download would otherwise hang the run
      // forever (node-fetch has no timeout), so give up after `idleMs` of
      // silence. Slow-but-moving downloads keep resetting the timer.
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          const e = new Error(`download stalled: no data for ${Math.round(idleMs / 1000)}s`);
          e.code = "ETIMEDOUT";
          fail(e);
        }, idleMs);
      };
      arm();
      response.body.on("error", fail);
      response.body.on("data", (chunk) => {
        arm();
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
      fileStream.on("error", fail);
      fileStream.on("finish", () => {
        clearTimeout(idle);
        if (!failed) resolve();
      });
      response.body.pipe(fileStream);
    });
    // Atomic on the same filesystem (tmp is a sibling of the destination).
    fs.renameSync(tmpPath, filePath);
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
    waits.noteActivity(line);
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
    const filePath = path.join(dir, filename);
    // Same ".part"-then-rename discipline as streamToFile: an interrupted write
    // never leaves a truncated file at the real path for a resumed run to trust.
    const tmpPath = filePath + ".part";
    await new Promise((resolve, reject) => {
      const textStream = Readable.from(data);
      const fileStream = fs.createWriteStream(tmpPath);
      const fail = (err) => {
        try {
          fileStream.destroy();
        } catch (e) {
          /* ignore */
        }
        fs.rm(tmpPath, { force: true }, () => reject(err));
      };
      textStream.on("error", fail);
      fileStream.on("error", fail);
      fileStream.on("finish", resolve);
      textStream.pipe(fileStream);
    });
    fs.renameSync(tmpPath, filePath);
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
   * @param {string} courseUrl e.g "<canvas url>/courses/38628"
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

  // Folders created (or reused) in THIS run. On a re-run a folder left from a
  // PREVIOUS run is the same item, so it's reused rather than getting a " (n)"
  // sibling; only a name genuinely reused within one run is disambiguated.
  // Reset per course by resetCreatedDirs().
  _createdDirs: new Set(),

  /** Clears the created-this-run folder set (call once per course). */
  resetCreatedDirs() {
    this._createdDirs = new Set();
  },

  /**
   * Resolves the directory an item should be saved in, reusing an existing
   * folder instead of duplicating it — so the scrape is safe to re-run.
   *
   * Two levels of reuse:
   *  - Identity (when `identity`, a stable item URL, is given): if the manifest
   *    recorded a folder for this item, reuse it even if the display name
   *    changed — renaming the folder in place (and moving its manifest asset
   *    paths with it) when it did. This is what keeps an assignment whose grade
   *    suffix updated mid-term from spawning a second folder.
   *  - Name: a folder left from a previous run (same name, not created in THIS
   *    run) is the same item and is reused. A name reused within one run (two
   *    genuinely distinct items that sanitize alike) still gets " (2)", " (3)".
   *
   * Missing parent directories are created as needed.
   * @param {string} desiredPath the directory path to create
   * @param {string} [identity] a stable item URL used to find a renamed folder
   * @returns {string} the path actually used (may carry a " (n)" suffix)
   */
  mkUniqueDir(desiredPath, identity = null) {
    // Dry-run writes nothing, so don't create (or uniquify) any directories;
    // just hand back the path callers use to build download destinations.
    if (this.dryRun) return desiredPath;
    const parent = path.dirname(desiredPath);
    const base = path.basename(desiredPath);
    fs.mkdirSync(parent, { recursive: true });

    // Identity-based reuse (survives a rename of the display name).
    if (identity != null && manifest.enabled) {
      const recordedRel = manifest.lookupDir(identity);
      if (recordedRel) {
        const recordedAbs = path.join(manifest.courseDir, recordedRel);
        if (fs.existsSync(recordedAbs)) {
          if (recordedAbs === desiredPath) {
            this._createdDirs.add(recordedAbs);
            return recordedAbs;
          }
          // The display name changed — rename the existing folder to the new
          // name and move its manifest asset paths with it, so a resumed run
          // still finds the files inside instead of re-downloading them.
          const target = this._freeDirName(parent, base, {
            avoidDisk: true,
            skip: recordedAbs,
          });
          try {
            fs.renameSync(recordedAbs, target);
            manifest.relocate(
              path.relative(manifest.courseDir, recordedAbs),
              path.relative(manifest.courseDir, target)
            );
            manifest.recordDir(identity, target);
            this._createdDirs.add(target);
            return target;
          } catch (e) {
            // Rename failed — reuse in place rather than duplicating.
            this._createdDirs.add(recordedAbs);
            return recordedAbs;
          }
        }
      }
    }

    // Name-based reuse: only step past a name we already used THIS run.
    const candidate = this._freeDirName(parent, base);
    if (!fs.existsSync(candidate)) fs.mkdirSync(candidate);
    this._createdDirs.add(candidate);
    if (identity != null && manifest.enabled) manifest.recordDir(identity, candidate);
    return candidate;
  },

  /**
   * The first "<base>", "<base> (2)", ... under `parent` not already claimed.
   * A name used earlier in THIS run always counts as taken. A folder that
   * merely exists on disk (from a previous run) is a collision only when
   * `avoidDisk` is set (choosing a fresh rename target); otherwise it's meant
   * to be reused, so it's not stepped past. `skip` is an absolute path treated
   * as free even if it exists (the folder being renamed away from).
   * @param {string} parent parent directory
   * @param {string} base desired folder basename
   * @param {object} [opts]
   * @param {boolean} [opts.avoidDisk] also skip names that already exist on disk
   * @param {string} [opts.skip] a path to treat as free even if it exists
   */
  _freeDirName(parent, base, { avoidDisk = false, skip = null } = {}) {
    let candidate = path.join(parent, base);
    let n = 2;
    const taken = (c) =>
      c !== skip && (this._createdDirs.has(c) || (avoidDisk && fs.existsSync(c)));
    while (taken(candidate)) {
      candidate = path.join(parent, `${base} (${n})`);
      n++;
    }
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
