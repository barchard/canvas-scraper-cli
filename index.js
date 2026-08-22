import fs from "fs";
import { Command } from "commander";
import puppeteer from "puppeteer";
import http from "http";
import inquirer from "inquirer";

import helpers from "./scrapers/helpers.js";
import scrapers from "./scrapers/index.js";
import report from "./scrapers/report.js";
import wiki from "./scrapers/wiki.js";
import octarine from "./scrapers/octarine.js";

/**
 * Parses the target URL into a Canvas domain and (optional) course id.
 * - "https://<domain>"                    -> all of the user's courses
 * - "https://<domain>/courses/<course_id>" -> a single course
 */
function parseTarget(url) {
  let m = url.match(/^https:\/\/([^/]+)\/?$/);
  if (m) return { domain: `https://${m[1]}`, courseId: null };

  m = url.match(/^https:\/\/([^/]+)\/courses\/([^/?#]+)/);
  if (m) return { domain: `https://${m[1]}`, courseId: m[2] };

  helpers.print(
    "ERROR",
    "URL",
    "Invalid URL. Use 'https://<school_domain>' for all your courses, or 'https://<school_domain>/courses/<course_id>' for a single course. Exiting...",
    0
  );
  process.exit(1);
}

/**
 * Scrapes one course into `courseDir` (homepage PDF + the selected sections).
 */
async function scrapeCourse(browser, cookies, courseUrl, courseDir, toScrape, courseName) {
  console.log(`*** SCRAPING COURSE FROM ${courseUrl} ***`);
  fs.mkdirSync(courseDir, { recursive: true });

  // Attribute every asset downloaded below to this course in the --report CSV.
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

  if (toScrape.a) await scrapers.scrapeAssignments(browser, cookies, courseUrl, courseDir);
  if (toScrape.m) await scrapers.scrapeModules(browser, cookies, courseUrl, courseDir);
  if (toScrape.q) await scrapers.scrapeQuizzes(browser, cookies, courseUrl, courseDir);
  if (toScrape.v) await scrapers.scrapeVideos(browser, cookies, courseUrl, courseDir);
  if (toScrape.s) await scrapers.scrapeStudyNet(browser, cookies, courseUrl, courseDir);

  console.log(`*** FINISHED SCRAPING ${courseUrl} ***`);
}

function readJSON(path, varName) {
  try {
    return JSON.parse(fs.readFileSync(path));
  } catch (e) {
    helpers.print("ERROR", varName, "Could not read cookies. Exiting...", 0, e);
    process.exit(1);
  }
}

const argDef = [
  {
    type: "input",
    name: "[url]",
    message:
      "Enter a Course URL (https://<school_domain>/courses/<course_id>) or just the domain (https://<school_domain>) to scrape all your courses:",
    validate: (input) =>
      /^https:\/\/[^/]+(\/courses\/[^/]+)?\/?$/.test(input) ||
      "Invalid URL. Use https://<school_domain> (all courses) or https://<school_domain>/courses/<course_id> (one course).",
    description:
      "Course URL, or a bare https://<school_domain> to scrape all your courses",
  },
];

const flagDef = [
  {
    type: "input",
    name: "output",
    message: "Please enter the output directory name:",
    default: "courses/course",
    flags: "-o, --output <dir_name>",
    description: "output directory name",
  },
  {
    type: "input",
    name: "cookies",
    message: "Please enter the path to the cookies file:",
    default: "cookies.json",
    flags: "-c, --cookies <path>",
    description: "path to cookies file",
    onlyShowValid: true,
    validate: (input) => {
      if (!fs.existsSync(input))
        return "File does not exist. Please enter a valid path.";
      if (!input.toLowerCase().endsWith("json"))
        return "Invalid file format. Please enter a path to a JSON file.";
      return true;
    },
  },
  {
    type: "confirm",
    name: "a",
    message: "Do you want to scrape assignments?",
    default: false,
    flags: "-a",
    description: "scrape assignments",
  },
  {
    type: "confirm",
    name: "m",
    message: "Do you want to scrape modules?",
    default: false,
    flags: "-m",
    description: "scrape modules",
  },
  {
    type: "confirm",
    name: "q",
    message: "Do you want to scrape quizzes?",
    default: false,
    flags: "-q",
    description: "scrape quizzes",
  },
  {
    type: "confirm",
    name: "v",
    message: "Do you want to scrape the Videos (Panopto) page?",
    default: false,
    flags: "-v",
    description: "scrape the Videos (Panopto) page",
  },
  {
    type: "confirm",
    name: "s",
    message: "Do you want to scrape the Study.Net Materials page?",
    default: false,
    flags: "-s",
    description: "scrape the Study.Net Materials page",
  },
  {
    type: "confirm",
    name: "t",
    message:
      "Do you want to transcribe downloaded videos? (runs config.json transcribeCommand)",
    default: false,
    flags: "-t",
    description: "transcribe downloaded videos via config.json transcribeCommand",
  },
  {
    type: "confirm",
    name: "report",
    message:
      "Do you want to write a CSV report of every downloaded asset (report.csv)?",
    default: false,
    flags: "--report",
    description: "write a report.csv listing every downloaded asset",
  },
  {
    type: "confirm",
    name: "wiki",
    message:
      "Do you want to organize the output as an LLM Wiki (raw/ + index.md + wiki/)?",
    default: false,
    flags: "--wiki",
    description:
      "organize output into the Karpathy LLM Wiki layout (raw/, wiki/, index.md)",
  },
  {
    type: "confirm",
    name: "octarine",
    message:
      "Do you want to organize the output as an Octarine workspace (.attachments/ + course notes)?",
    default: false,
    flags: "--octarine",
    description:
      "organize output into an Octarine workspace (.attachments/, course notes, Index.md)",
  },
];

const program = new Command();
program
  .name("Canvas Scraper CLI")
  .description(
    "A NodeJS command-line interface for scraping and downloading data (e.g. assignments and modules) from a Canvas course."
  );

argDef.forEach((arg) => program.argument(arg.name, arg.description));

flagDef.forEach((flag) =>
  program.option(flag.flags, flag.description, flag.default)
);

program.option("--all", "scrape all content types (-a -m -q -v -s)");

program.action(async (url, options) => {
  if (!url) {
    helpers.print("NOTE", "URL", "No URL provided. Entering wizard...");
    const answers = await inquirer.prompt(argDef.concat(flagDef));

    url = answers.url;
    Object.assign(options, answers);
  }

  // url parsing -> domain + optional course id
  const { domain, courseId } = parseTarget(url);
  // read cookies
  const cookies = readJSON(options.cookies, "cookies");
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

  // opt-in CSV report of every downloaded asset (written to <output>/report.csv).
  // --wiki and --octarine also need the recorder on: they use the source URLs
  // to link each catalog entry back to where it came from.
  if (options.report || options.wiki || options.octarine) report.enable();

  console.log(`FLAGS: ${JSON.stringify(options)}`);

  // create (fresh) output directory
  const dir = options.output;
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // figure out what to scrape (t is a separate modifier, handled above)
  const toScrape = { a: options.a, m: options.m, q: options.q, v: options.v, s: options.s };
  if (options.all) {
    for (const key in toScrape) toScrape[key] = true;
  }
  if (Object.values(toScrape).every((v) => !v)) {
    helpers.print("NOTE", "FLAGS", "No flags set. Scraping all...", 0);
    for (const key in toScrape) toScrape[key] = true;
  }

  const browser = await puppeteer.launch({ headless: "new" });

  if (courseId) {
    // single course -> output straight into `dir`
    await scrapeCourse(browser, cookies, `${domain}/courses/${courseId}`, dir, toScrape);
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
    } else {
      helpers.print("NOTE", "COURSES", `Found ${courses.length} course(s).`, 0);
      for (const c of courses) {
        const courseDir = `${dir}/${helpers.stripInvalid(`${c.name} (${c.id})`)}`;
        try {
          await scrapeCourse(
            browser,
            cookies,
            `${domain}/courses/${c.id}`,
            courseDir,
            toScrape,
            c.name
          );
        } catch (e) {
          helpers.print(
            "ERROR",
            "COURSE",
            `Could not scrape ${c.name} (${c.id})`,
            0,
            e
          );
        }
      }
    }
  }

  browser.close();

  if (options.report) {
    try {
      const reportPath = `${dir}/report.csv`;
      const count = report.write(reportPath);
      helpers.print(
        "NOTE",
        "REPORT",
        `Wrote ${count} asset(s) to ${reportPath}`,
        0
      );
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

  // opt-in reorganization into the LLM Wiki layout (raw/ + index.md + wiki/).
  // Runs last so it can sweep everything else the run produced into raw/.
  if (options.wiki) {
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
  // --wiki and --octarine are alternative layouts of the same files; if both
  // are set, --wiki already claimed the output, so skip Octarine.
  if (options.octarine) {
    if (options.wiki) {
      helpers.print(
        "WARNING",
        "OCTARINE",
        "--wiki and --octarine are alternative layouts; --wiki was applied, skipping --octarine.",
        0
      );
    } else {
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

  console.log("*** DONE ***");
});

program.parse();
