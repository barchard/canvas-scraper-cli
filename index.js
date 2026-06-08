import fs from "fs";
import { Command } from "commander";
import puppeteer from "puppeteer";
import http from "http";
import inquirer from "inquirer";

import helpers from "./scrapers/helpers.js";
import scrapers from "./scrapers/index.js";

function parseUrl(url) {
  const regex = /^https:\/\/([^/]+)\/courses\/([^/]+)(\/.*)?$/;
  const match = url.match(regex);
  if (!match) {
    helpers.print(
      "ERROR",
      "URL",
      "Invalid URL. Please follow the 'https://<school_domain>/courses/<course_id>' format. Exiting...",
      0
    );
    process.exit(1);
  }

  return `https://${match[1]}/courses/${match[2]}`;
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
      "Please enter the Course Homepage URL (e.g. https://<school_domain>/courses/<course_id>):",
    validate: (input) =>
      /^https:\/\/[^/]+\/courses\/[^/]+$/.test(input) ||
      "Invalid URL format. The URL should match the pattern https://<school_domain>/courses/<course_id>",
    description:
      "Course Homepage URL (e.g. https://<school_domain>/courses/<course_id>)",
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

program.action(async (url, options) => {
  if (!url) {
    helpers.print("NOTE", "URL", "No URL provided. Entering wizard...");
    const answers = await inquirer.prompt(argDef.concat(flagDef));

    url = answers.url;
    Object.assign(options, answers);
  }

  // url parsing
  url = parseUrl(url);
  // read cookies
  const cookies = readJSON(options.cookies, "cookies");
  process.env.config = JSON.stringify(readJSON("config.json", "config"));

  console.log(`*** SCRAPING COURSE FROM ${url} ***`);
  console.log(`FLAGS: ${JSON.stringify(options)}`);

  // create output directory
  const dir = options.output;
  if (fs.existsSync(dir)) fs.rmSync(dir, { directory: true, recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  // scrape course
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await helpers.newPage(browser, cookies, url);
  if (page.status !== 200) {
    helpers.print(
      "ERROR",
      "HOMEPAGE",
      "Could not load homepage. Exiting...",
      0,
      http.STATUS_CODES[page.status]
    );
    process.exit(1);
  }
  await page.pdf({ path: `${dir}/HOMEPAGE.pdf`, format: "Letter" });
  page.close();

  const toScrape = { a: options.a, m: options.m, q: options.q, v: options.v };
  if (Object.values(toScrape).every((v) => !v)) {
    helpers.print("NOTE", "FLAGS", "No flags set. Scraping all...", 0);
    for (const key in toScrape) toScrape[key] = true;
  }
  if (toScrape.a) await scrapers.scrapeAssignments(browser, cookies, url, dir);
  if (toScrape.m) await scrapers.scrapeModules(browser, cookies, url, dir);
  if (toScrape.q) await scrapers.scrapeQuizzes(browser, cookies, url, dir);
  if (toScrape.v) await scrapers.scrapeVideos(browser, cookies, url, dir);

  browser.close();
  console.log(`*** FINISHED SCRAPING ${url} ***`);
});

program.parse();
