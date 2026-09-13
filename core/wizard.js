import fs from "fs";
import inquirer from "inquirer";

import { launchBrowser } from "./browser.js";
import { parseTarget, readCookies } from "./scrape.js";
import { runLogin } from "./login.js";
import helpers from "../scrapers/helpers.js";

/**
 * The guided, no-argument experience (`node index.js` with no URL).
 *
 * Walks the user through the whole run interactively:
 *   1. Canvas URL (school domain, or a specific course URL).
 *   2. Cookies — log in now in a browser (default), or point at an existing file.
 *   3. What to scrape (assignments / modules / quizzes / videos / study.net).
 *   4. Which course — pick one from the user's enrolled courses, or all of them
 *      (only asked when the URL was a bare domain rather than a course URL).
 *   5. Output directory and extra layout/report options.
 *
 * @returns {Promise<{url: string, options: object}>} a fully-resolved target
 *   URL and the options object runScrape() expects.
 */
export async function runWizard() {
  const URL_RE = /^https:\/\/[^/]+(\/courses\/[^/]+)?\/?$/;

  // 1. Canvas URL.
  const { url } = await inquirer.prompt([
    {
      type: "input",
      name: "url",
      message:
        "Enter your Canvas URL (https://<school_domain>, or a specific course URL):",
      validate: (input) =>
        URL_RE.test((input || "").trim()) ||
        "Invalid URL. Use https://<school_domain> or https://<school_domain>/courses/<course_id>.",
      filter: (input) => (input || "").trim(),
    },
  ]);

  const { domain, courseId } = parseTarget(url);

  // 2. Cookies: log in now (recommended) or reuse an existing file.
  const { cookieSource } = await inquirer.prompt([
    {
      type: "list",
      name: "cookieSource",
      message: "How should we get your Canvas session cookies?",
      choices: [
        { name: "Log in now (opens a browser) — recommended", value: "login" },
        { name: "Use an existing cookies file", value: "file" },
      ],
      default: "login",
    },
  ]);

  let cookiesPath;
  if (cookieSource === "login") {
    const { path } = await inquirer.prompt([
      {
        type: "input",
        name: "path",
        message: "Where should the captured cookies be saved?",
        default: "cookies.json",
        filter: (input) => (input || "").trim(),
      },
    ]);
    // Opens the browser, waits for the user to sign in, writes `path`.
    await runLogin(url, { cookies: path });
    cookiesPath = path;
  } else {
    const { path } = await inquirer.prompt([
      {
        type: "input",
        name: "path",
        message: "Path to your cookies file (JSON or Netscape format):",
        default: "cookies.json",
        filter: (input) => (input || "").trim(),
        validate: (input) =>
          fs.existsSync((input || "").trim()) ||
          "File does not exist. Please enter a valid path.",
      },
    ]);
    cookiesPath = path;
  }

  // 3. What to scrape.
  const { types } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "types",
      message: "What do you want to scrape? (space to toggle, enter to confirm)",
      choices: [
        { name: "Assignments", value: "a", checked: true },
        { name: "Modules", value: "m", checked: true },
        { name: "Quizzes", value: "q", checked: true },
        { name: "Videos (Panopto)", value: "v", checked: true },
        { name: "Study.Net Materials", value: "s", checked: true },
      ],
    },
  ]);

  // 4. Course selection (only meaningful for a bare-domain URL). For a specific
  //    course URL we already know the course.
  let targetUrl = url;
  if (!courseId) {
    const { scope } = await inquirer.prompt([
      {
        type: "list",
        name: "scope",
        message: "Scrape all your courses, or pick one?",
        choices: [
          { name: "Pick a specific course", value: "one" },
          { name: "All my courses", value: "all" },
        ],
        default: "one",
      },
    ]);

    if (scope === "one") {
      const chosenId = await pickCourse(domain, cookiesPath);
      if (chosenId) targetUrl = `${domain}/courses/${chosenId}`;
      // If no course could be chosen, fall through to the all-courses URL.
    }
  }

  // 5. Output directory + extras.
  const { output, extras } = await inquirer.prompt([
    {
      type: "input",
      name: "output",
      message: "Output directory:",
      default: "courses/course",
      filter: (input) => (input || "").trim(),
    },
    {
      type: "checkbox",
      name: "extras",
      message: "Any extras? (optional)",
      choices: [
        { name: "Write a CSV report of downloaded assets (--report)", value: "report" },
        { name: "Organize as an LLM Wiki (--wiki)", value: "wiki" },
        { name: "Organize as an Octarine workspace (--octarine)", value: "octarine" },
        { name: "Transcribe downloaded videos (-t)", value: "t" },
      ],
    },
  ]);

  const options = {
    output,
    cookies: cookiesPath,
    a: types.includes("a"),
    m: types.includes("m"),
    q: types.includes("q"),
    v: types.includes("v"),
    s: types.includes("s"),
    t: extras.includes("t"),
    report: extras.includes("report"),
    wiki: extras.includes("wiki"),
    octarine: extras.includes("octarine"),
    all: false,
    tui: false,
    login: false,
  };

  return { url: targetUrl, options };
}

/**
 * Fetches the user's enrolled courses and prompts them to choose one.
 * @param {string} domain e.g. "https://canvas.mit.edu"
 * @param {string} cookiesPath path to the cookies file just captured/selected
 * @returns {Promise<string|number|null>} the chosen course id, or null if none
 *   could be listed (caller then falls back to scraping all courses)
 */
async function pickCourse(domain, cookiesPath) {
  let cookies;
  try {
    cookies = readCookies(cookiesPath);
  } catch (e) {
    helpers.print("WARNING", "COURSES", `Could not read cookies: ${e.message}`, 0);
    return null;
  }

  helpers.print("NOTE", "COURSES", "Fetching your courses...", 0);
  let browser;
  let courses = [];
  try {
    browser = await launchBrowser();
    courses = await helpers.listCourses(domain, cookies, browser);
  } catch (e) {
    helpers.print("WARNING", "COURSES", `Could not list courses: ${e.message}`, 0);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!courses.length) {
    helpers.print(
      "WARNING",
      "COURSES",
      "No courses found (check your cookies / enrollments). Falling back to all courses.",
      0
    );
    return null;
  }

  const { chosen } = await inquirer.prompt([
    {
      type: "list",
      name: "chosen",
      message: `Which course? (${courses.length} found)`,
      pageSize: 15,
      choices: courses.map((c) => ({
        name: `${c.name} (${c.id})`,
        value: c.id,
      })),
    },
  ]);
  return chosen;
}

export default { runWizard };
