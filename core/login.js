import fs from "fs";
import readline from "readline";

import { launchBrowser } from "./browser.js";
import { parseTarget } from "./scrape.js";
import helpers from "../scrapers/helpers.js";

/**
 * Interactive cookie capture.
 *
 * Instead of exporting cookies with a browser extension and hand-merging the
 * JSON, the user logs in through a real browser window and we read the session
 * cookies straight out of Chrome over CDP (Network.getAllCookies), which — unlike
 * document.cookie / an extension reading the DOM — includes HttpOnly cookies
 * such as `canvas_session`. The captured cookies are written in the same
 * puppeteer-style JSON that readCookies() already consumes, so nothing
 * downstream changes.
 *
 * ── Extending this ────────────────────────────────────────────────────────
 * How cookies are captured is a pluggable *strategy*. Today only "fresh" is
 * implemented (a throwaway browser session; the user logs in every time). To
 * add another way to obtain cookies, add one entry to LOGIN_STRATEGIES — the
 * CLI/TUI wiring, the file format, and the scrape pipeline stay untouched:
 *
 *   - "persistent": launch with a persistent userDataDir (see
 *     launchBrowser({ userDataDir }) in core/browser.js) so the login survives
 *     across runs and the user rarely re-authenticates.
 *   - "attach": connect to the user's already-running Chrome via
 *     puppeteer.connect({ browserURL }) and read its cookies.
 *
 * Each strategy is `async ({ url, logger, prompt }) => cookies[]`, where the
 * returned cookies are raw CDP cookie objects (normalized by runLogin).
 */

/** Fields Chrome's CDP sameSite may report that puppeteer's setCookie accepts. */
const VALID_SAME_SITE = new Set(["Strict", "Lax", "None"]);

/**
 * "fresh" strategy: open a visible browser at the Canvas domain, wait for the
 * user to finish logging in (SSO / 2FA and all), then read every cookie in the
 * browser. No profile is persisted, so each capture is a clean login.
 */
async function freshSession({ url, logger, prompt }) {
  const { domain } = parseTarget(url);
  const browser = await launchBrowser({ headless: false });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto(domain, { waitUntil: "domcontentloaded" }).catch(() => {});

    logger("NOTE", "LOGIN", `A Chrome window has opened at ${domain}.`, 0);
    logger(
      "NOTE",
      "LOGIN",
      "Log in to Canvas. To download videos, also open and sign in to your " +
        "Panopto site in the same window.",
      0
    );
    await prompt(
      "When you're logged in, come back here and press Enter to save your cookies..."
    );

    // Network.getAllCookies returns every cookie in the browser (all domains,
    // HttpOnly included) — one shot captures Canvas and Panopto together.
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    return cookies;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Registry of capture strategies. Add new ways to obtain cookies here. */
export const LOGIN_STRATEGIES = {
  fresh: freshSession,
};

export const DEFAULT_LOGIN_MODE = "fresh";

/** Resolves a strategy by name, with a clear error listing what's available. */
export function getLoginStrategy(mode = DEFAULT_LOGIN_MODE) {
  const strategy = LOGIN_STRATEGIES[mode];
  if (!strategy) {
    throw new Error(
      `Unknown login mode "${mode}". Available: ${Object.keys(
        LOGIN_STRATEGIES
      ).join(", ")}.`
    );
  }
  return strategy;
}

/** Prompts on the terminal and resolves when the user presses Enter. */
function askEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${message}\n`, () => {
      rl.close();
      resolve();
    });
  });
}

/** Keeps only the fields readCookies()/setCookie care about, dropping junk. */
function normalizeCookies(cookies) {
  return cookies.map((c) => {
    const out = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      // CDP uses -1 for session cookies, which is exactly what puppeteer wants.
      expires: typeof c.expires === "number" ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    };
    if (VALID_SAME_SITE.has(c.sameSite)) out.sameSite = c.sameSite;
    return out;
  });
}

/**
 * Runs an interactive login and writes the captured cookies to disk.
 *
 * @param {string} url a Canvas target URL (course URL or bare domain); used to
 *   derive the domain the browser opens at.
 * @param {object} [options]
 * @param {string} [options.cookies="cookies.json"] path to write cookies to.
 * @param {string} [options.loginMode="fresh"] which capture strategy to use.
 * @param {(msg: string) => Promise<void>} [options.prompt] override the "press
 *   Enter" prompt (e.g. for the TUI). Defaults to a terminal readline prompt.
 * @returns {Promise<string>} the path the cookies were written to.
 * @throws {Error} on an unknown mode, an invalid URL, or if nothing was captured.
 */
export async function runLogin(url, options = {}) {
  const strategy = getLoginStrategy(options.loginMode);
  const cookiesPath = options.cookies || "cookies.json";
  const prompt = options.prompt || askEnter;
  const logger = (type, name, message, indent, additional) =>
    helpers.print(type, name, message, indent, additional);

  const captured = await strategy({ url, logger, prompt });

  if (!captured || captured.length === 0) {
    // Don't clobber a possibly-good existing file with nothing.
    throw new Error(
      "No cookies were captured — did you finish logging in before pressing " +
        `Enter? Left ${
          fs.existsSync(cookiesPath) ? `the existing ${cookiesPath}` : "no file"
        } untouched.`
    );
  }

  const normalized = normalizeCookies(captured);
  fs.writeFileSync(cookiesPath, `${JSON.stringify(normalized, null, 2)}\n`);
  helpers.print(
    "NOTE",
    "LOGIN",
    `Saved ${normalized.length} cookie(s) to ${cookiesPath}.`,
    0
  );
  return cookiesPath;
}

export default { runLogin, getLoginStrategy, LOGIN_STRATEGIES, DEFAULT_LOGIN_MODE };
