import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import os from "os";
import http from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import { Browser, Page } from "puppeteer";
import { Readable } from "stream";

const execFileAsync = promisify(execFile);

let warnedMissingYtDlp = false;
// Cached path to the Netscape cookie file generated for yt-dlp (built once).
let ytDlpCookieFile = null;

const exported = {
  /**
   * Creates a new page with the given cookies and navigates to the given URL
   * @param {Browser} browser puppeteer browser
   * @param {Object} cookies cookies to use
   * @param {string} url URL to navigate to
   * @returns {Promise<Page>} new page
   */
  async newPage(browser, cookies, url) {
    const page = await browser.newPage();
    await page.setCookie(...cookies);
    const response = await page.goto(url);
    page.status = response.status();
    return page;
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

    let filename = backupName;
    const contentDisposition = response.headers.get("content-disposition");
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="(.+?)"/);
      if (match) {
        filename = match[1];
        filename = this.stripInvalid(filename);
      }
    }

    const fileStream = fs.createWriteStream(path.join(dir, filename));
    await response.body.pipe(fileStream);
    return !(filename === backupName);
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
        return `${url.protocol}//${url.host}/Panopto/Pages/Sessions/List.aspx?folderID=${folderId}`;
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

    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(path.join(dir, filename));
      response.body.on("error", reject);
      fileStream.on("error", reject);
      fileStream.on("finish", resolve);
      response.body.pipe(fileStream);
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
      response = await fetch(url, { method: "GET", redirect: "follow" });
    } catch (e) {
      return false;
    }
    if (!response.ok) return false;

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

      await page.pdf({
        path: path.join(dir, name),
        format: "Letter",
        printBackground: true,
      });
      return true;
    } catch (e) {
      return false;
    } finally {
      if (page) await page.close().catch(() => {});
    }
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
    ];

    // For a single video, don't expand any playlist the URL happens to belong to.
    if (kind === "single") args.push("--no-playlist");

    const cookieFile = this.getYtDlpCookieFile(cookies);
    if (cookieFile) args.push("--cookies", cookieFile);

    // Optional post-download transcription: run the configured command on each
    // finished file ({} -> the file path). yt-dlp runs this once per downloaded
    // video, so playlists/folders are covered automatically.
    if (process.env.transcribe === "true") {
      let cmd = "";
      try {
        cmd = JSON.parse(process.env.config || "{}").transcribeCommand || "";
      } catch (e) {
        // no/invalid config
      }
      if (cmd) args.push("--exec", cmd);
    }

    args.push(url);

    try {
      await execFileAsync("yt-dlp", args);
      return true;
    } catch (e) {
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
        return false;
      }
      this.print("WARNING", "YT-DLP", `Could not download ${url}`, 0, e.stderr || e.message);
      return false;
    }
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
   * @returns {Promise<{handled: boolean, ok?: boolean}>} handled=false means this
   *   wasn't an HBS launch (caller should treat it as un-downloadable)
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

    let page;
    try {
      page = await this.newPage(browser, cookies, retrieveUrl);
      // The launch auto-submits a signed form; give it a moment to settle.
      await page
        .waitForNetworkIdle({ idleTime: 1000, timeout: 15000 })
        .catch(() => {});

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
            if (!res.ok) return { ok: false };
            const ct = res.headers.get("content-type") || "";
            const cd = res.headers.get("content-disposition") || "";
            if (!/pdf|octet-stream/i.test(ct) && !/\.pdf/i.test(cd)) {
              return { ok: false };
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
            };
          });
        } catch (e) {
          result = null;
        }

        if (result === null) continue; // no PDF form in this frame
        if (!result.ok) return { handled: true, ok: false };

        let filename = null;
        const m =
          result.contentDisposition &&
          result.contentDisposition.match(
            /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i
          );
        if (m) {
          try {
            filename = decodeURIComponent(m[1]);
          } catch (e) {
            filename = m[1];
          }
        }
        if (!filename) filename = (result.availabilityId || "document") + ".pdf";
        if (!/\.pdf$/i.test(filename)) filename += ".pdf";

        const buf = Buffer.from(result.base64, "base64");
        fs.writeFileSync(path.join(dir, this.stripInvalid(filename)), buf);
        return { handled: true, ok: true };
      }

      // HBS launch, but no downloadable PDF (e.g video / online reader only).
      return { handled: true, ok: false };
    } catch (e) {
      return { handled: true, ok: false };
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
        continue;
      }

      try {
        const success = this.isVideoHost(hostname)
          ? await this.downloadVideo(url, dir, cookies)
          : await this.downloadExternalResource(page.browser(), url, dir, i);
        if (!success) problematic.push(url);
      } catch (e) {
        problematic.push(url);
      }
    }

    // LTI external-tool launches (e.g Harvard Business Publishing cases). For HBS
    // we perform the signed launch in the authenticated browser and submit the
    // "Download PDF" form to fetch the file. Anything we can't download (a
    // non-HBS tool, or an HBS item with no PDF) is surfaced so it can be opened
    // and saved manually (the Canvas URL performs the launch while signed in).
    for (const url of lti) {
      let ok = false;
      try {
        const r = await this.downloadLtiPdf(page.browser(), cookies, url, dir);
        ok = !!(r && r.handled && r.ok);
      } catch (e) {
        ok = false;
      }
      if (!ok) problematic.push(url);
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
  print(type, name, message, indent = 0, additional = null) {
    console.log(`[${type}]${"  ".repeat(indent)} ${name} | ${message}`);
    if (additional) console.log(additional);
  },

  /**
   * Writes data to a file
   * @param {string} dir directory to write to
   * @param {string} filename name of file to write to
   * @param {any} data data to write
   */
  async writeFile(dir, filename, data) {
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
            let name = section.querySelector(headerSelector).innerText;
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
    fs.mkdirSync(`${dir}/${this.types[type].p.toUpperCase()}`);
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
      return;
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

    await page.pdf({
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
        fs.mkdirSync(
          `${dir}/${this.types[type].p.toUpperCase()}/${section.name}`
        );
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
