import fs from "fs";
import http from "http";

import { launchBrowser } from "./browser.js";
import helpers from "../scrapers/helpers.js";
import scrapers from "../scrapers/index.js";
import report from "../scrapers/report.js";
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
  fs.mkdirSync(courseDir, { recursive: true });

  // Attribute every asset downloaded below to this course in the report.
  report.setCourse(courseName, courseUrl);

  const page = await helpers.newPage(browser, cookies, courseUrl);
  if (page.status !== 200) {
    helpers.print(
      "ERROR",
      "HOMEPAGE",
      `Could not load homepage for ${courseUrl}. Skipping...`,
      0,
      http.STATUS_CODES[page.status]
    );
    await page.close().catch(() => {});
    return;
  }
  // When no name was passed (single-course mode), fall back to the homepage title.
  if (!courseName) {
    const title = await page.title().catch(() => "");
    if (title) report.setCourse(title.trim(), courseUrl);
  }
  await page.pdf({ path: `${courseDir}/HOMEPAGE.pdf`, format: "Letter" });
  await page.close().catch(() => {});

  for (const [key, label, fn] of PHASES) {
    if (!toScrape[key]) continue;
    onProgress({ type: "phase", label, courseName });
    await fn(browser, cookies, courseUrl, courseDir);
  }

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

  let browser;
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
    // links in --wiki / --octarine, so enable it for any of the three.
    if (options.report || options.wiki || options.octarine) report.enable();

    emit(`FLAGS: ${JSON.stringify(options)}`);

    // create (fresh) output directory
    const dir = options.output;
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const toScrape = resolveToScrape(options);

    // Prefer the locally installed Google Chrome ("chrome" channel) over
    // Puppeteer's bundled Chromium: the bundled build is pinned to an old
    // version that crashes on launch under newer macOS releases. Fall back to
    // the bundled browser if no local Chrome is found.
    browser = await launchBrowser();

    let courseCount = 0;
    if (courseId) {
      // single course -> output straight into `dir`
      const courseUrl = `${domain}/courses/${courseId}`;
      onProgress({ type: "start", mode: "single", total: 1 });
      onProgress({ type: "course", index: 1, total: 1, name: null, url: courseUrl });
      await scrapeCourse(browser, cookies, courseUrl, dir, toScrape, null, onProgress);
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
      const courses = await helpers.listCourses(domain, cookies, browser);
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
          const courseDir = `${dir}/${helpers.stripInvalid(`${c.name} (${c.id})`)}`;
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
    helpers.setPrinter(prevPrinter);
  }
}

export default { runScrape, parseTarget, readJSON };
