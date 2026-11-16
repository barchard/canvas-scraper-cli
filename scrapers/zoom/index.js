import fs from "fs";
import os from "os";
import path from "path";
import helpers from "../helpers.js";
import report from "../report.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zoom's media CDN refuses the signed recording URL without this Referer.
const ZOOM_REFERER = "https://zoom.us/";
// Where the Zoom LTI Pro app ("Zoom" course tab) lives.
const LTI_HOST = "applications.zoom.us";

/** True if the URL's hostname is zoom.us or a subdomain (not a substring match). */
export function isZoomHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "zoom.us" || h.endsWith(".zoom.us");
  } catch (e) {
    return false;
  }
}

/**
 * Pulls the LTI session id (`lti_scid`) out of a Zoom LTI API request URL.
 * Every call the Zoom tab makes carries it; we need it to call the API ourselves.
 * @param {string} u request URL
 * @returns {string|null}
 */
export function ltiScidFromUrl(u) {
  try {
    const url = new URL(u);
    if (url.hostname.toLowerCase() !== LTI_HOST) return null;
    return url.searchParams.get("lti_scid") || null;
  } catch (e) {
    return null;
  }
}

/**
 * The MP4 files of a recording that have a play URL (the ones a student can
 * stream). Audio-only (M4A), TIMELINE, CHAT etc. are skipped.
 * @param {Array<object>} files recordingFiles from the /recording/file API
 * @returns {Array<object>}
 */
export function playableMp4s(files) {
  return (files || []).filter(
    (f) => f && String(f.fileType).toUpperCase() === "MP4" && f.playUrl
  );
}

/**
 * Formats a Zoom UTC timestamp ("2026-11-09 23:55:17") as "YYYY-MM-DD HHMM" in
 * the meeting's time zone, falling back to UTC if the zone is unknown.
 * @param {string} utc
 * @param {string} [timeZone] IANA zone, e.g. "America/New_York"
 * @returns {string}
 */
export function formatZoomTime(utc, timeZone) {
  const d = new Date(String(utc || "").replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  const fmt = (tz) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}${parts.minute}`;
  };
  try {
    return fmt(timeZone || "UTC");
  } catch (e) {
    return fmt("UTC");
  }
}

/**
 * Output basename (no extension) for one MP4 of a recording:
 * "<date time> <topic>", plus " - part N" when the meeting has several MP4s
 * (e.g. separate speaker / shared-screen views).
 * @param {object} rec a recording from the course list (startTime, timezone, topic)
 * @param {number} index 0-based index of this MP4 within the recording
 * @param {number} count number of MP4s in the recording
 * @returns {string}
 */
export function recordingFilename(rec, index, count) {
  const when = formatZoomTime(rec.startTime, rec.timezone);
  let name = [when, rec.topic || "Zoom recording"].filter(Boolean).join(" ");
  if (count > 1) name += ` - part ${index + 1}`;
  return helpers.stripInvalid(name);
}

/**
 * Renders the player's transcript entries as WebVTT, prefixing each cue with
 * the speaker's name.
 * @param {Array<{startTime:string,endTime:string,text:string,userName?:string}>} items
 * @returns {string}
 */
export function transcriptToVtt(items) {
  const cues = (items || [])
    .filter((it) => it && it.startTime && it.endTime && it.text)
    .map((it, i) => {
      const speaker = it.userName ? `<v ${it.userName}>` : "";
      return `${i + 1}\n${it.startTime} --> ${it.endTime}\n${speaker}${it.text}`;
    });
  return ["WEBVTT", ...cues].join("\n\n") + "\n";
}

/**
 * Finds the course's "Zoom" navigation tab (an external-tool launch) and
 * returns its absolute URL, or null if there isn't one.
 */
async function findZoomTabUrl(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => (s || "").trim().toLowerCase();
    const links = Array.from(document.querySelectorAll("#section-tabs a"));
    const isTool = (a) => /\/external_tools\//.test(a.getAttribute("href") || a.href);
    let match = links.find((a) => norm(a.textContent) === norm(label) && isTool(a));
    if (!match) match = links.find((a) => norm(a.textContent).includes("zoom") && isTool(a));
    return match ? match.href : null;
  }, label);
}

/**
 * The auth headers the Zoom app sends on its own API calls (an XSRF token and
 * x-zm-* account/cluster ids). The API answers 403 without them, so we replay
 * them on ours.
 * @param {Record<string,string>} headers a captured request's headers
 * @returns {Record<string,string>}
 */
export function ltiApiHeaders(headers) {
  const out = { accept: "application/json, text/plain, */*" };
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key === "x-xsrf-token" || key.startsWith("x-zm-")) out[key] = v;
  }
  return out;
}

/** Calls a Zoom LTI API path from inside the Zoom frame (same origin, its cookies). */
async function ltiGet(frame, apiPath, headers) {
  return frame.evaluate(
    async (p, h) => {
      const r = await fetch(p, { credentials: "include", headers: h });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${p}`);
      return r.json();
    },
    apiPath,
    headers
  );
}

/** Lists every cloud recording the Zoom tab shows for the course (all pages). */
async function listCourseRecordings(frame, scid, headers) {
  // The tab defaults endTime to "today"; ask for tomorrow so a recording made
  // late today in another time zone isn't cut off.
  const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const q = new URLSearchParams({
      startTime: "",
      endTime: end,
      keyWord: "",
      searchType: "1",
      status: "",
      page: String(page),
      total: "0",
      lti_scid: scid,
    });
    const json = await ltiGet(frame, `/api/v1/lti/rich/recording/COURSE?${q}`, headers);
    const res = (json && json.result) || {};
    const list = res.list || [];
    all.push(...list);
    if (!list.length || all.length >= (res.total || 0)) break;
  }
  return all;
}

/** The files (MP4/M4A/…) of one recording, each with its streaming play URL. */
async function recordingFiles(frame, scid, headers, meetingId) {
  const q = new URLSearchParams({ meetingId, lti_scid: scid });
  const json = await ltiGet(frame, `/api/v1/lti/rich/recording/file?${q}`, headers);
  return (json && json.result && json.result.recordingFiles) || [];
}

/**
 * Signs in to the institution's Zoom (e.g. mit.zoom.us) through its SAML SSO,
 * which rides the existing IdP session from the cookies. Returns whether we
 * ended up signed in.
 */
async function zoomSso(page, zoomOrigin) {
  await page
    .goto(`${zoomOrigin}/saml/login`, { waitUntil: "networkidle2", timeout: 60000 })
    .catch(() => {});
  // The IdP page auto-posts the SAML response back to Zoom with script, which
  // can happen after goto() settles — so wait for the page to land back on Zoom
  // (signed in) rather than judging the IdP page. Staying on the IdP means it
  // wants an interactive login (expired session); /signin means Zoom refused.
  const signedIn = (u) => isZoomHost(u) && !/\/signin|\/saml\//i.test(u);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const u = page.url();
    if (signedIn(u)) return true;
    if (isZoomHost(u) && /\/signin/i.test(u)) return false;
    await sleep(500);
  }
  return signedIn(page.url());
}

/**
 * Opens a recording's play page and captures, from the player's own API calls,
 * the signed media URL (and the transcript, if the player loads one).
 * @returns {Promise<{mediaUrl: string|null, transcript: Array|null, signedOut: boolean}>}
 */
async function resolvePlayUrl(page, playUrl) {
  let mediaUrl = null;
  let transcript = null;
  const onResponse = async (r) => {
    const u = r.url();
    if (!isZoomHost(u) || !/\/nws\/recording\/[\d.]+\/share\//.test(u)) return;
    try {
      const json = await r.json();
      const res = (json && json.result) || {};
      if (res.mediaInfo && res.mediaInfo.playUrl) mediaUrl = res.mediaInfo.playUrl;
      if (/\/transcript\?/.test(u) && Array.isArray(res.dataList)) transcript = res.dataList;
    } catch (e) {
      /* preflight / non-JSON */
    }
  };
  page.on("response", onResponse);
  try {
    await page.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    // Wait for the media URL; then give the transcript a moment to arrive too.
    const deadline = Date.now() + 30000;
    while (!mediaUrl && Date.now() < deadline) {
      if (/\/signin/i.test(page.url())) break;
      await sleep(500);
    }
    const tDeadline = Date.now() + 5000;
    while (mediaUrl && !transcript && Date.now() < tDeadline) await sleep(500);
  } finally {
    page.off("response", onResponse);
  }
  return { mediaUrl, transcript, signedOut: /\/signin/i.test(page.url()) };
}

/**
 * Scrapes the course's "Zoom" tab (Zoom LTI Pro): lists its cloud recordings
 * through the tab's own API, signs in to the institution's Zoom via SSO, and
 * downloads every MP4 (plus its transcript as .vtt when available) into ZOOM/.
 * Works even when the host disabled downloads, since it uses the streaming
 * copy. Best-effort and never throws.
 */
async function scrapeZoom(browser, cookies, url, dir) {
  console.log("=== SCRAPING ZOOM ===");
  const zoomDir = `${dir}/ZOOM`;
  const cookieFile = path.join(os.tmpdir(), `canvas-scraper-zoom-cookies-${process.pid}.txt`);

  let coursePage;
  let toolPage;
  let playPage;
  try {
    if (!helpers.dryRun) fs.mkdirSync(zoomDir, { recursive: true });

    const label = JSON.parse(process.env.config || "{}").zoomTabLabel || "Zoom";

    // 1. Find the course's Zoom nav tab.
    coursePage = await helpers.newPage(browser, cookies, url);
    if (coursePage.status !== 200) {
      helpers.print("ERROR", "ZOOM", "Could not load course page. Skipping...", 0);
      return;
    }
    const tabUrl = await findZoomTabUrl(coursePage, label).catch(() => null);
    if (!tabUrl) {
      helpers.print("NOTE", "ZOOM", `No "${label}" tab in the course navigation. Skipping...`, 0);
      return;
    }

    // 2. Launch it, noting the LTI session id and auth headers from the app's
    //    own API calls.
    toolPage = await browser.newPage();
    if (cookies && cookies.length) await toolPage.setCookie(...cookies);
    let scid = null;
    let apiHeaders = null;
    toolPage.on("request", (r) => {
      if (scid && apiHeaders) return;
      const id = ltiScidFromUrl(r.url());
      if (!id) return;
      scid = scid || id;
      if (!apiHeaders && /\/api\/v1\/lti\//.test(r.url())) apiHeaders = ltiApiHeaders(r.headers());
    });
    await toolPage
      .goto(tabUrl, { waitUntil: "networkidle2", timeout: 60000 })
      .catch(() => {});
    const deadline = Date.now() + 30000;
    let frame = null;
    while (Date.now() < deadline && !(frame && scid && apiHeaders)) {
      frame = toolPage.frames().find((f) => {
        try {
          return new URL(f.url()).hostname === LTI_HOST;
        } catch (e) {
          return false;
        }
      });
      if (!(frame && scid && apiHeaders)) await sleep(1000);
    }
    if (!frame || !scid || !apiHeaders) {
      report.recordFailure(tabUrl, "could not open the Zoom tab");
      helpers.print("WARNING", "ZOOM", `Could not open the Zoom tab. Open it manually: ${tabUrl}`, 0);
      return;
    }

    // 3. List the course's cloud recordings.
    const recordings = await listCourseRecordings(frame, scid, apiHeaders);
    if (!recordings.length) {
      helpers.print("NOTE", "ZOOM", "No cloud recordings in the Zoom tab.", 0);
      return;
    }
    helpers.print("NOTE", "ZOOM", `Found ${recordings.length} cloud recording(s)`, 0);

    // 4. Resolve each recording's MP4 files (and their play URLs).
    const jobs = [];
    for (const rec of recordings) {
      let files = [];
      try {
        files = playableMp4s(await recordingFiles(frame, scid, apiHeaders, rec.meetingId));
      } catch (e) {
        report.recordFailure(tabUrl, `could not list files for "${rec.topic}" (${rec.startTime})`);
        helpers.print("WARNING", "ZOOM", `Could not list files for ${rec.topic} (${rec.startTime})`, 1, e.message);
        continue;
      }
      if (!files.length) {
        report.recordFailure(tabUrl, `no playable MP4 for "${rec.topic}" (${rec.startTime})`);
        helpers.print("WARNING", "ZOOM", `No playable MP4 for ${rec.topic} (${rec.startTime})`, 1);
      }
      files.forEach((f, i) =>
        jobs.push({ playUrl: f.playUrl, filename: recordingFilename(rec, i, files.length) })
      );
    }
    if (!jobs.length) return;

    // Resume: skip recordings already on disk before doing any (slow) player work.
    const pending = helpers.dryRun
      ? jobs
      : jobs.filter((j) => !fs.existsSync(path.join(zoomDir, `${j.filename}.mp4`)));
    if (pending.length < jobs.length) {
      helpers.print("NOTE", "ZOOM", `${jobs.length - pending.length} recording(s) already downloaded`, 0);
    }
    if (!pending.length) return;

    // 5. Sign in to the institution's Zoom through SSO (once).
    const zoomOrigin = new URL(pending[0].playUrl).origin;
    playPage = await browser.newPage();
    if (cookies && cookies.length) await playPage.setCookie(...cookies);
    if (!(await zoomSso(playPage, zoomOrigin))) {
      report.recordFailure(zoomOrigin, "Zoom SSO sign-in failed");
      helpers.print(
        "WARNING",
        "ZOOM",
        `Could not sign in to ${zoomOrigin} via SSO — your identity-provider cookies may have expired. Re-capture cookies and try again.`,
        0
      );
      return;
    }

    // 6. For each MP4: open its player, grab the signed media URL, download it.
    for (const job of pending) {
      helpers.print("NOTE", "ZOOM", `${helpers.dryRun ? "Probing" : "Downloading"} ${job.filename}`, 0);
      const { mediaUrl, transcript, signedOut } = await resolvePlayUrl(playPage, job.playUrl);
      if (!mediaUrl) {
        report.recordFailure(job.playUrl, signedOut ? "Zoom session signed out" : "could not resolve Zoom media URL");
        helpers.print("WARNING", "ZOOM", `Could not resolve the video for ${job.filename}. Open it manually: ${job.playUrl}`, 1);
        continue;
      }

      // The signed URL needs the Zoom session cookies captured in the browser.
      const zoomCookies = await playPage.cookies(job.playUrl, ZOOM_REFERER, mediaUrl);
      if (!helpers.writeNetscapeCookieFile(zoomCookies, cookieFile)) continue;

      const ok = await helpers
        .downloadVideo(mediaUrl, zoomDir, cookies, {
          cookieFile,
          referer: ZOOM_REFERER,
          filename: job.filename,
        })
        .catch(() => false);
      if (!ok) {
        report.recordFailure(job.playUrl, "Zoom recording download failed");
        helpers.print("WARNING", "ZOOM", `Could not download ${job.filename}. Open it manually: ${job.playUrl}`, 1);
      }

      if (ok && transcript && transcript.length && !helpers.dryRun) {
        const vtt = path.join(zoomDir, `${job.filename}.vtt`);
        try {
          if (!fs.existsSync(vtt)) fs.writeFileSync(vtt, transcriptToVtt(transcript));
        } catch (e) {
          helpers.print("WARNING", "ZOOM", `Could not save transcript for ${job.filename}`, 1, e.message);
        }
      }
    }
  } catch (e) {
    helpers.print("ERROR", "ZOOM", "Could not scrape the Zoom tab", 0, e);
  } finally {
    for (const p of [coursePage, toolPage, playPage]) if (p) await p.close().catch(() => {});
    try {
      fs.rmSync(cookieFile, { force: true });
    } catch (e) {
      /* ignore */
    }
    // Don't leave an empty ZOOM/ behind when nothing downloaded.
    if (!helpers.dryRun) {
      try {
        if (fs.existsSync(zoomDir) && fs.readdirSync(zoomDir).length === 0) fs.rmdirSync(zoomDir);
      } catch (e) {
        /* ignore */
      }
    }
    console.log("=== DONE SCRAPING ZOOM ===");
  }
}

export default scrapeZoom;
