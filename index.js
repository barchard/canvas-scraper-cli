import fs from "fs";
import { Command } from "commander";
import inquirer from "inquirer";

import helpers from "./scrapers/helpers.js";
import { runScrape } from "./core/scrape.js";
import { runLogin } from "./core/login.js";
import { renderTui } from "./tui/app.js";

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
    // No URL -> the unified Ink wizard: it prompts for the URL, logs in, asks
    // what to scrape, lets the user pick a course (or all), then runs the
    // scrape — all in one terminal UI.
    if (!url) {
      await renderTui(undefined, {});
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
