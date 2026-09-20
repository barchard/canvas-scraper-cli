import fs from "fs";
import { Command } from "commander";
import inquirer from "inquirer";

import helpers from "./scrapers/helpers.js";
import { runScrape } from "./core/scrape.js";
import { runLogin } from "./core/login.js";
import { renderTui } from "./tui/app.js";
import { ensureChrome } from "./core/chrome.js";

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
    default: "courses",
    flags: "-o, --output <dir_name>",
    description:
      "main output directory; each course is saved in its own subfolder named after the course",
  },
  {
    type: "input",
    name: "cookies",
    message: "Please enter the path to the cookies file:",
    default: "cookies.json",
    flags: "-c, --cookies <path>",
    description: "path to cookies file (JSON or Netscape HTTP Cookie File)",
    onlyShowValid: true,
    validate: (input) => {
      if (!fs.existsSync(input))
        return "File does not exist. Please enter a valid path.";
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
    name: "dryRun",
    message:
      "Do you want a dry run (probe for inaccessible articles/artifacts without downloading)?",
    default: false,
    flags: "--dry-run",
    description:
      "probe every article/artifact for accessibility and write dry-run-report.csv, without downloading anything",
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
program.option(
  "--courses <ids>",
  "comma-separated course ids to scrape (subset of a bare-domain URL); omit for all courses"
);
program.option("--tui", "run with the interactive terminal UI (Ink)");
program.option(
  "--login",
  "open a browser to log in and capture cookies before scraping"
);
program.option(
  "--login-mode <mode>",
  "cookie capture strategy for --login (fresh)",
  "fresh"
);

// `login` subcommand: capture cookies interactively, then exit (no scrape).
program
  .command("login [url]")
  .description(
    "open a browser to log in and save your Canvas (and Panopto) cookies"
  )
  .option("-c, --cookies <path>", "path to write the cookies file", "cookies.json")
  .option("--login-mode <mode>", "cookie capture strategy (fresh)", "fresh")
  .action(async (url, opts) => {
    try {
      // Every flow drives a real Chrome; fail early with install help if absent.
      ensureChrome();
      if (!url) {
        const { loginUrl } = await inquirer.prompt([
          {
            type: "input",
            name: "loginUrl",
            message:
              "Enter your Canvas URL (https://<school_domain>, or a course URL):",
            validate: (input) =>
              /^https:\/\/[^/]+(\/courses\/[^/]+)?\/?$/.test(input) ||
              "Invalid URL. Use https://<school_domain> or https://<school_domain>/courses/<course_id>.",
          },
        ]);
        url = loginUrl;
      }
      await runLogin(url, { cookies: opts.cookies, loginMode: opts.loginMode });
    } catch (e) {
      helpers.print("ERROR", "LOGIN", e.message || String(e), 0);
      process.exit(1);
    }
  });

program.action(async (url, options) => {
  try {
    // Every flow drives a real Chrome; fail early with install help if absent.
    ensureChrome();

    // Normalize --courses into the courseIds array runScrape expects.
    if (typeof options.courses === "string") {
      options.courseIds = options.courses
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // No URL -> the unified Ink wizard: it prompts for the URL, then shows an
    // action menu (Log in / About / Scrape …). Scraping browses the courses
    // first, then asks what to download — all in one terminal UI.
    if (!url) {
      await renderTui(undefined, {});
      return;
    }

    // Whether the user asked to scrape specific content up front. When they
    // didn't (a bare interactive `<url>` or `--tui <url>`), open the action
    // menu instead of scraping; flag-driven runs stay non-interactive.
    const hasContentFlags =
      options.a || options.m || options.q || options.v || options.s || options.all;

    // Passing --courses or --dry-run is an explicit non-interactive intent to
    // scrape (content defaults to everything), so don't divert to the action
    // menu for it.
    if (!hasContentFlags && !options.login && !options.courses && !options.dryRun) {
      await renderTui(url, { ...options, _menu: true });
      return;
    }

    // --tui renders the run in an Ink terminal UI; otherwise stream to the
    // console. The TUI drives --login itself (as an interactive first phase),
    // so only run the standalone capture here for the non-TUI path.
    if (options.tui) {
      await renderTui(url, options);
      return;
    }

    // --login: capture fresh cookies into options.cookies before scraping.
    if (options.login) {
      await runLogin(url, {
        cookies: options.cookies,
        loginMode: options.loginMode,
      });
    }

    await runScrape(url, options);
  } catch (e) {
    helpers.print("ERROR", "SCRAPE", e.message || String(e), 0);
    process.exit(1);
  }
});

program.parse();
