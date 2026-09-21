import fs from "fs";
import http from "http";

import { launchBrowser } from "./browser.js";
import helpers from "../scrapers/helpers.js";
import scrapers from "../scrapers/index.js";
import report from "../scrapers/report.js";
import manifest from "../scrapers/manifest.js";
import wiki from "../scrapers/wiki.js";
import octarine from "../scrapers/octarine.js";

/**
 * Headless scrape core. Every front-end (the CLI, the Ink TUI, and eventually
 * an Electron GUI) calls runScrape() rather than reimplementing the workflow.
 *
 * The core never assumes a particular UI: instead of printing, it reports
 * through the optional `hooks`:
 *   - hooks.onLog({ type, name, message, indent, additional, line })
 *       receives every helpers.print() line produced during the run.
 *   - hooks.onProgress(event) receives structured progress:
 *       { type: "start", mode, total }
 *       { type: "course", index, total, name, url }
 *       { type: "phase", label, courseName }
 *       { type: "course-end", index, total }
 *       { type: "done", summary }
 * Omit hooks entirely and it behaves like the original CLI (prints to console).
 */

/**
 * Parses the target URL into a Canvas domain and (optional) course id.
 * - "https://<domain>"                     -> all of the user's courses
 * - "https://<domain>/courses/<course_id>"  -> a single course
 * @throws {Error} if the URL is not a recognized Canvas target
 */
export function parseTarget(url) {
  let m = url.match(/^https:\/\/([^/]+)\/?$/);
  if (m) return { domain: `https://${m[1]}`, courseId: null };

  m = url.match(/^https:\/\/([^/]+)\/courses\/([^/?#]+)/);
  if (m) return { domain: `https://${m[1]}`, courseId: m[2] };

  throw new Error(
    "Invalid URL. Use 'https://<school_domain>' for all your courses, or " +
      "'https://<school_domain>/courses/<course_id>' for a single course."
  );
}

/**
 * Reads and parses a JSON file.
 * @throws {Error} if the file can't be read or parsed
 */
export function readJSON(path, varName) {
  try {
    return JSON.parse(fs.readFileSync(path));
  } catch (e) {
    throw new Error(`Could not read ${varName} from "${path}": ${e.message}`);
  }
}

/**
 * Parses a Netscape HTTP Cookie File (the tab-separated format exported by
 * browser extensions, curl, and yt-dlp) into puppeteer-style cookie objects.
 *
 * Each data line has 7 tab-separated fields:
 *   domain  includeSubdomains  path  secure  expiry  name  value
 * Lines starting with "#" are comments, except the "#HttpOnly_" prefix that
 * some tools prepend to a domain to mark an HttpOnly cookie.
 * @param {string} text raw file contents
 * @returns {Array<object>} puppeteer-style cookies (name, value, domain, ...)
 */
export function parseNetscapeCookies(text) {
  const cookies = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // "#HttpOnly_" is the one comment-looking prefix that carries data.
    let httpOnly = false;
    let dataLine = raw;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      dataLine = raw.replace(/^#HttpOnly_/, "");
    } else if (line.startsWith("#")) {
      continue;
    }

    const fields = dataLine.split("\t");
    if (fields.length < 7) continue;

    const [domain, , path, secure, expiry, name, ...valueParts] = fields;
    const expires = Number(expiry);
    cookies.push({
      name,
      value: valueParts.join("\t"),
      domain,
      path: path || "/",
      // Netscape uses 0 for session cookies; puppeteer expects -1.
      expires: Number.isFinite(expires) && expires > 0 ? expires : -1,
      httpOnly,
      secure: secure.toUpperCase() === "TRUE",
    });
  }
  return cookies;
}

/**
 * Reads a cookies file, auto-detecting the format (JSON array of puppeteer-style
 * cookies, or a Netscape HTTP Cookie File) and returning puppeteer-style cookies.
 * @throws {Error} if the file can't be read or no cookies could be parsed
 */
export function readCookies(path) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Could not read cookies from "${path}": ${e.message}`);
  }

  const trimmed = text.trimStart();
  // JSON cookie exports start with an array (or, rarely, a single object).
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`Could not parse cookies from "${path}": ${e.message}`);
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const cookies = parseNetscapeCookies(text);
  if (cookies.length === 0) {
    throw new Error(
      `Could not parse cookies from "${path}": expected a JSON array or a Netscape HTTP Cookie File.`
    );
  }
  return cookies;
}

/** Resolves which content types to scrape from the options (--all / defaults). */
function resolveToScrape(options) {
  const toScrape = {
    a: options.a,
    m: options.m,
    q: options.q,
    v: options.v,
    s: options.s,
  };
  if (options.all) for (const key in toScrape) toScrape[key] = true;
  if (Object.values(toScrape).every((v) => !v)) {
    helpers.print("NOTE", "FLAGS", "No flags set. Scraping all...", 0);
    for (const key in toScrape) toScrape[key] = true;
  }
  return toScrape;
}

// Content types in scrape order: [option key, progress label, scraper fn].
const PHASES = [
  ["a", "Assignments", scrapers.scrapeAssignments],
  ["m", "Modules", scrapers.scrapeModules],
  ["q", "Quizzes", scrapers.scrapeQuizzes],
  ["v", "Videos", scrapers.scrapeVideos],
  ["s", "Study.Net", scrapers.scrapeStudyNet],
];

/**
 * Builds a self-contained, macOS/Windows-safe folder name for a course.
 *
 * The folder is named after the course (sanitized via helpers.stripInvalid).
 * The course id is appended only when it's needed to keep the name usable or
 * unique: when the sanitized name is empty, or when another course in this run
 * already claimed the same name.
 * @param {string} name the course name (may be empty/null)
 * @param {(string|number)} id the course id
 * @param {Set<string>} [used] lowercased folder names already used this run
 * @returns {string} the folder name (relative, never empty)
 */
function courseFolderName(name, id, used) {
  let base = helpers.stripInvalid(name || "");
  // stripInvalid returns "untitled" for an empty name — fall back to the id.
  if (!name || base === "untitled") base = helpers.stripInvalid(`course-${id}`);

  let folder = base;
  if (used && used.has(folder.toLowerCase())) {
    folder = helpers.stripInvalid(`${base} (${id})`);
  }
  if (used) used.add(folder.toLowerCase());
  return folder;
}

/**
 * Scrapes one course into `courseDir` (homepage PDF + the selected sections).
 */
async function scrapeCourse(
  browser,
  cookies,
  courseUrl,
  courseDir,
  toScrape,
  courseName,
  onProgress
) {
  helpers.print("INFO", "COURSE", `Scraping ${courseUrl}`, 0);
  // Prepare this course's own folder without disturbing sibling courses in the
  // main output folder. A dry-run writes nothing, so it must never wipe or
  // create the folder (that would destroy the results of a previous real
  // scrape).
  //
  // Default (resume): keep whatever is already on disk and reconcile in place —
  // a re-run only re-downloads what's missing or incomplete, so it's safe to
  // run repeatedly. --fresh restores the old wipe-and-rebuild behavior for a
  // clean slate.
  if (!helpers.dryRun) {
    if (helpers.fresh && fs.existsSync(courseDir)) {
      fs.rmSync(courseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(courseDir, { recursive: true });
  }

  // Attribute every asset downloaded below to this course in the report.
  report.setCourse(courseName, courseUrl);

  // Load this course's download manifest so downloaders can skip files already
  // on disk and re-fetch only what's missing/incomplete. Skipped in a dry-run
  // (which writes nothing and probes accessibility instead). A --fresh run just
  // wiped the folder, so the manifest starts empty and everything re-downloads.
  if (!helpers.dryRun) manifest.load(courseDir, courseUrl);
  // Fresh per-course folder-reuse tracking so item folders from a previous run
  // are reused in place rather than duplicated with a " (n)" suffix.
  helpers.resetCreatedDirs();

  const page = await helpers.newPage(browser, cookies, courseUrl);
  if (page.status !== 200) {
    helpers.print(
      "ERROR",
      "HOMEPAGE",
      `Could not load homepage for ${courseUrl}. Skipping...`,
      0,
      http.STATUS_CODES[page.status]
    );
    // In a dry-run, an unreachable homepage is itself an inaccessible article.
    if (helpers.dryRun) {
      report.recordFailure(courseUrl, helpers.describeHttpFailure(courseUrl, page.status));
    }
    await page.close().catch(() => {});
    return;
  }
  // When no name was passed (single-course mode), fall back to the homepage title.
  if (!courseName) {
    const title = await page.title().catch(() => "");
    if (title) report.setCourse(title.trim(), courseUrl);
  }
  await helpers.capturePdf(page, { path: `${courseDir}/HOMEPAGE.pdf`, format: "Letter" });
  await page.close().catch(() => {});

  for (const [key, label, fn] of PHASES) {
    if (!toScrape[key]) continue;
    onProgress({ type: "phase", label, courseName });
    await fn(browser, cookies, courseUrl, courseDir);
  }

  // Persist the manifest so the next run can resume this course. Reset the
  // current-course state either way so it never leaks into the next course.
  if (!helpers.dryRun) manifest.save();
  manifest.reset();

  helpers.print("INFO", "COURSE", `Finished ${courseUrl}`, 0);
}

/** Writes the report CSVs (if --report). Errors are logged, not thrown. */
function writeReports(dir) {
  try {
    const reportPath = `${dir}/report.csv`;
    const count = report.write(reportPath);
    helpers.print("NOTE", "REPORT", `Wrote ${count} asset(s) to ${reportPath}`, 0);
  } catch (e) {
    helpers.print("ERROR", "REPORT", "Could not write report.csv", 0, e);
  }

  try {
    const skippedPath = `${dir}/report-skipped.csv`;
    const skippedCount = report.writeSkipped(skippedPath);
    if (skippedCount > 0) {
      helpers.print(
        "NOTE",
        "REPORT",
        `Wrote ${skippedCount} skipped/failed download(s) to ${skippedPath}`,
        0
      );
    }
  } catch (e) {
    helpers.print("ERROR", "REPORT", "Could not write report-skipped.csv", 0, e);
  }
}

/**
 * Writes errors.csv listing every error raised during the run, so failures can
 * be tracked and resolved. No-op when there were no errors (or no output dir).
 * Best-effort: its own failure is swallowed so it can run inside a finally.
 */
function writeErrorsReport(dir) {
  if (!dir || !report.errors.length) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const errorsPath = `${dir}/errors.csv`;
    const count = report.writeErrors(errorsPath);
    if (count > 0) {
      // helpers.print only records ERROR lines, so a NOTE/WARNING here won't
      // append to the very list we just wrote.
      helpers.print("NOTE", "ERRORS", `Wrote ${count} error(s) to ${errorsPath}`, 0);
    }
  } catch (e) {
    helpers.print("WARNING", "ERRORS", "Could not write errors.csv", 0, e.message || e);
  }
}

/**
 * Writes download-diagnostics.jsonl listing rich snapshots of downloads that
 * failed despite the item being potentially completable by hand (e.g HBSP LTI
 * launches). No-op when nothing was captured (or no output dir). Best-effort:
 * its own failure is swallowed so it can run inside a finally.
 */
function writeDiagnosticsReport(dir) {
  if (!dir || !report.diagnostics.length) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const diagPath = `${dir}/download-diagnostics.jsonl`;
    const count = report.writeDiagnostics(diagPath);
    if (count > 0) {
      helpers.print(
        "NOTE",
        "DIAGNOSTICS",
        `Wrote ${count} download diagnostic(s) to ${diagPath}`,
        0
      );
    }
  } catch (e) {
    helpers.print(
      "WARNING",
      "DIAGNOSTICS",
      "Could not write download-diagnostics.jsonl",
      0,
      e.message || e
    );
  }
}

/**
 * Writes the dry-run accessibility report (dry-run-report.csv) and prints a
 * summary of how many articles/artifacts were accessible vs inaccessible.
 * Errors are logged, not thrown.
 */
function writeDryRunReport(dir) {
  try {
    const reportPath = `${dir}/dry-run-report.csv`;
    const { total, inaccessible, accessible } = report.writeDryRun(reportPath);
    helpers.print(
      "NOTE",
      "DRY-RUN",
      `Probed ${total} item(s): ${accessible} accessible, ${inaccessible} inaccessible.`,
      0
    );
    helpers.print("NOTE", "DRY-RUN", `Wrote ${reportPath}`, 0);
    // Echo the inaccessible items so they're visible without opening the CSV.
    if (inaccessible > 0) {
      helpers.print("WARNING", "DRY-RUN", "Inaccessible articles/artifacts:", 0);
      for (const r of report.skipped) {
        const where = r.courseName ? ` [${r.courseName}]` : "";
        helpers.print("WARNING", "DRY-RUN", `  ${r.url} — ${r.reason}${where}`, 0);
      }
    }
  } catch (e) {
    helpers.print("ERROR", "DRY-RUN", "Could not write dry-run-report.csv", 0, e);
  }
}

/**
 * Runs a full scrape described by `options`, reporting progress through `hooks`.
 * @param {string} url the target Canvas URL
 * @param {object} options scrape options (a/m/q/v/s, all, output, cookies, t,
 *   report, wiki, octarine) — the same shape the CLI/wizard produce
 * @param {object} [hooks] { onLog, onProgress } — optional UI callbacks
 * @returns {Promise<{outputDir: string, courseCount: number, single: boolean}>}
 */
export async function runScrape(url, options, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const emit = (line) =>
    hooks.onLog
      ? hooks.onLog({ type: "INFO", name: "", message: line, line })
      : console.log(line);

  // Route every helpers.print() line to the front-end for the duration of the
  // run, then restore whatever was there before (so nested/repeat runs are safe).
  const prevPrinter = helpers.printer;
  if (hooks.onLog) helpers.setPrinter((rec) => hooks.onLog(rec));

  // Route download progress to the front-end. With a UI (onProgress) we forward
  // structured events; on the plain CLI we print throttled milestone lines for
  // videos so a big download isn't silent.
  const prevProgressSink = helpers.progressSink;
  helpers.setProgressSink(makeProgressSink(hooks, onProgress));

  // A --dry-run probes every article/artifact for accessibility without writing
  // anything to disk (no PDFs, files, or videos). Turn on the recorder so the
  // probe results are collected, and route byte-writing helpers to record-only.
  const prevDryRun = helpers.dryRun;
  helpers.setDryRun(!!options.dryRun);

  // --fresh wipes and rebuilds each course folder; the default reconciles in
  // place (a safe, repeatable re-run). Set/reset like dryRun.
  const prevFresh = helpers.fresh;
  helpers.setFresh(!!options.fresh);

  // --force re-downloads assets the manifest already marks complete (in case an
  // on-disk file is suspected corrupt); the default trusts the manifest.
  const prevForce = manifest.force;
  manifest.setForce(!!options.force);

  // Reset per-run error and diagnostic tracking so the reports reflect only
  // this run.
  report.errors = [];
  report.diagnostics = [];

  let browser;
  // Hoisted so the finally can always write errors.csv, even if the run throws.
  let dir = options.output;
  try {
    const { domain, courseId } = parseTarget(url);
    const cookies = readCookies(options.cookies);
    process.env.config = JSON.stringify(readJSON("config.json", "config"));

    // opt-in transcription of downloaded videos (via config.json transcribeCommand)
    if (options.t) {
      process.env.transcribe = "true";
      if (!JSON.parse(process.env.config).transcribeCommand) {
        helpers.print(
          "WARNING",
          "TRANSCRIBE",
          'Transcription enabled (-t) but "transcribeCommand" is empty in config.json. Videos will not be transcribed.',
          0
        );
      }
    }

    // The report recorder is the data source for --report and for the source
    // links in --wiki / --octarine, so enable it for any of the three. A
    // --dry-run also needs it — the probe results are its whole output.
    if (options.report || options.wiki || options.octarine || options.dryRun)
      report.enable();

    emit(`FLAGS: ${JSON.stringify(options)}`);

    // Ensure the main output folder exists. It holds one self-contained
    // subfolder per course, so we don't wipe it here (that would delete sibling
    // courses from earlier runs) — each course's own folder is refreshed instead.
    dir = options.output;
    fs.mkdirSync(dir, { recursive: true });

    const toScrape = resolveToScrape(options);

    // Prefer the locally installed Google Chrome ("chrome" channel) over
    // Puppeteer's bundled Chromium: the bundled build is pinned to an old
    // version that crashes on launch under newer macOS releases. Fall back to
    // the bundled browser if no local Chrome is found.
    browser = await launchBrowser();

    let courseCount = 0;
    if (courseId) {
      // single course -> its own self-contained folder inside the main folder,
      // named after the course (falling back to the id if the name is unavailable).
      const courseUrl = `${domain}/courses/${courseId}`;
      const courseName = await helpers.getCourseName(domain, courseId, cookies);
      const courseDir = `${dir}/${courseFolderName(courseName, courseId, null)}`;
      onProgress({ type: "start", mode: "single", total: 1 });
      onProgress({ type: "course", index: 1, total: 1, name: courseName, url: courseUrl });
      await scrapeCourse(browser, cookies, courseUrl, courseDir, toScrape, courseName, onProgress);
      onProgress({ type: "course-end", index: 1, total: 1 });
      courseCount = 1;
    } else {
      // bare domain -> every course, each into its own subfolder of `dir`
      helpers.print(
        "NOTE",
        "COURSES",
        `No course id in URL — scraping all your courses on ${domain}...`,
        0
      );
      let courses = await helpers.listCourses(domain, cookies, browser);

      // Narrow to a chosen subset when the caller passed specific course ids
      // (the TUI course picker). An empty/absent list means "all courses".
      if (Array.isArray(options.courseIds) && options.courseIds.length) {
        const wanted = new Set(options.courseIds.map(String));
        const subset = courses.filter((c) => wanted.has(String(c.id)));
        const missing = [...wanted].filter(
          (id) => !courses.some((c) => String(c.id) === id)
        );
        if (missing.length) {
          helpers.print(
            "WARNING",
            "COURSES",
            `Selected course id(s) not found in your enrollments: ${missing.join(", ")}`,
            0
          );
        }
        courses = subset;
      }

      if (!courses.length) {
        helpers.print(
          "WARNING",
          "COURSES",
          "No courses found. Check that your cookies are valid and you have active enrollments.",
          0
        );
        onProgress({ type: "start", mode: "all", total: 0 });
      } else {
        helpers.print("NOTE", "COURSES", `Found ${courses.length} course(s).`, 0);
        onProgress({ type: "start", mode: "all", total: courses.length });
        let index = 0;
        const usedFolders = new Set();
        for (const c of courses) {
          index++;
          const courseUrl = `${domain}/courses/${c.id}`;
          onProgress({
            type: "course",
            index,
            total: courses.length,
            name: c.name,
            url: courseUrl,
          });
          const courseDir = `${dir}/${courseFolderName(c.name, c.id, usedFolders)}`;
          try {
            await scrapeCourse(browser, cookies, courseUrl, courseDir, toScrape, c.name, onProgress);
            courseCount++;
          } catch (e) {
            helpers.print("ERROR", "COURSE", `Could not scrape ${c.name} (${c.id})`, 0, e);
          }
          onProgress({ type: "course-end", index, total: courses.length });
        }
      }
    }

    await browser.close();
    browser = null;

    // A dry-run's whole output is the accessibility report; write it and skip the
    // download report and the wiki/octarine reorganizers (there's nothing on disk
    // to organize).
    if (options.dryRun) {
      writeDryRunReport(dir);
      const summary = { outputDir: dir, courseCount, single: !!courseId, dryRun: true };
      onProgress({ type: "done", summary });
      emit("*** DONE (dry run — nothing downloaded) ***");
      return summary;
    }

    if (options.report) writeReports(dir);

    // opt-in reorganization into the LLM Wiki layout (raw/ + index.md + wiki/).
    // Runs last so it can sweep everything else the run produced into raw/.
    if (options.wiki) {
      onProgress({ type: "phase", label: "LLM Wiki" });
      try {
        const { sources } = wiki.build(dir, report.rows);
        helpers.print(
          "NOTE",
          "WIKI",
          `Organized ${sources} source(s) into ${dir}/raw and wrote ${dir}/index.md`,
          0
        );
      } catch (e) {
        helpers.print("ERROR", "WIKI", "Could not organize output as an LLM Wiki", 0, e);
      }
    }

    // opt-in reorganization into an Octarine workspace (.attachments/ + notes).
    // --wiki and --octarine are alternative layouts; if both are set, --wiki
    // already claimed the output, so skip Octarine.
    if (options.octarine) {
      if (options.wiki) {
        helpers.print(
          "WARNING",
          "OCTARINE",
          "--wiki and --octarine are alternative layouts; --wiki was applied, skipping --octarine.",
          0
        );
      } else {
        onProgress({ type: "phase", label: "Octarine" });
        try {
          const { sources, notes } = octarine.build(dir, report.rows);
          helpers.print(
            "NOTE",
            "OCTARINE",
            `Organized ${sources} source(s) into ${dir}/.attachments and wrote ${notes} course note(s)`,
            0
          );
        } catch (e) {
          helpers.print(
            "ERROR",
            "OCTARINE",
            "Could not organize output as an Octarine workspace",
            0,
            e
          );
        }
      }
    }

    const summary = { outputDir: dir, courseCount, single: !!courseId };
    onProgress({ type: "done", summary });
    emit("*** DONE ***");
    return summary;
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Always flush tracked errors to errors.csv (best-effort). This runs even
    // when the scrape threw, so a failed run still leaves a record to resolve.
    writeErrorsReport(dir);
    // Likewise flush any rich failure diagnostics (e.g HBSP LTI launches that
    // couldn't be downloaded) so the scraper can be updated to handle them.
    writeDiagnosticsReport(dir);
    helpers.setPrinter(prevPrinter);
    helpers.setProgressSink(prevProgressSink);
    helpers.setDryRun(prevDryRun);
    helpers.setFresh(prevFresh);
    manifest.setForce(prevForce);
  }
}

/** Formats a byte count as a short human-readable string (e.g. "1.4 GB"). */
function fmtBytes(n) {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/**
 * Builds the download-progress sink for runScrape. With a UI it forwards each
 * event as `onProgress({ type: "download", ... })`. On the plain CLI (no UI) it
 * prints throttled milestone lines for videos so a large download isn't silent.
 */
function makeProgressSink(hooks, onProgress) {
  if (hooks.onProgress) {
    return (evt) => onProgress({ type: "download", ...evt });
  }
  // Console fallback: milestone lines for videos and transcriptions (plain files
  // are quick, so they stay silent). Progress prints at ~10% steps.
  const lastPctByName = new Map();
  return (evt) => {
    if (evt.scope !== "video" && evt.scope !== "transcribe") return;
    const label = evt.scope === "transcribe" ? "TRANSCRIBE" : "YT-DLP";
    const where = evt.count ? ` (${evt.index || "?"}/${evt.count})` : "";

    if (evt.phase === "start") {
      const icon = evt.scope === "transcribe" ? "📝" : "⬇";
      helpers.print("NOTE", label, `${icon} ${evt.name}${where}`, 1);
      lastPctByName.set(evt.name, -1);
      return;
    }
    if (evt.phase === "done") {
      lastPctByName.delete(evt.name);
      return;
    }
    if (evt.percent == null) return; // indeterminate (e.g. a quiet transcriber)
    const bucket = Math.floor(evt.percent / 10) * 10;
    if (bucket > (lastPctByName.get(evt.name) ?? -1)) {
      lastPctByName.set(evt.name, bucket);
      const size =
        evt.scope === "video" && evt.total
          ? ` (${fmtBytes(evt.received)}/${fmtBytes(evt.total)})`
          : "";
      const speed = evt.scope === "video" && evt.speed ? ` @ ${fmtBytes(evt.speed)}/s` : "";
      helpers.print("NOTE", label, `  ${bucket}%${size}${speed} — ${evt.name}`, 1);
    }
  };
}

export default { runScrape, parseTarget, readJSON };
