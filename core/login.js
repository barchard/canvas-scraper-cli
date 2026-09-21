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

// Public video providers that serve without a login, so their cookies aren't
// needed for downloads — excluded from the "did we capture auth cookies?" check.
const PUBLIC_VIDEO_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "vimeo.com",
]);

/** Best-effort read of config.json from the working directory (empty on failure). */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync("config.json"));
  } catch (e) {
    return {};
  }
}

/**
 * Hostnames whose session cookies are needed for login-gated video downloads:
 * Panopto (always) plus any non-public hosts the user added to config.json's
 * `videoHosts`. Public providers (YouTube, Vimeo) are excluded — they need no
 * login, so their absence from the cookie jar isn't a problem.
 * @param {object} [config] parsed config.json
 * @returns {string[]}
 */
export function videoAuthHosts(config = {}) {
  const hosts = ["panopto.com"];
  if (Array.isArray(config.videoHosts)) {
    for (const h of config.videoHosts) {
      const s = String(h).toLowerCase().trim();
      if (s && !PUBLIC_VIDEO_HOSTS.has(s)) hosts.push(s);
    }
  }
  return [...new Set(hosts)];
}

/** Hostname(s) whose session cookies Study.Net downloads need. */
export function studyNetAuthHosts() {
  return ["study.net"];
}

/**
 * Whether the captured cookies include a session for any of `hosts` (matching a
 * host exactly or as a subdomain, ignoring a leading dot).
 * @param {Array<{domain?: string}>} cookies captured cookies
 * @param {string[]} hosts hostnames to look for
 * @returns {boolean}
 */
export function hasCookiesForHosts(cookies, hosts) {
  return (cookies || []).some((c) => {
    const d = String(c && c.domain ? c.domain : "").replace(/^\./, "").toLowerCase();
    return hosts.some((h) => d === h || d.endsWith(`.${h}`));
  });
}

/** Back-compat alias: whether cookies cover the login-gated video host(s). */
export function hasVideoAuthCookies(cookies, hosts) {
  return hasCookiesForHosts(cookies, hosts);
}

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
    let cookies = (await client.send("Network.getAllCookies")).cookies;

    // Verify we captured cookies for the login-gated content sources — Panopto
    // (videos) and Study.Net (course-pack materials) — BEFORE closing the
    // browser, so the user can fix it now rather than discovering it only when
    // those downloads silently fail during a scrape. Give one guided retry
    // (auto-opening a configured URL where we have one) so they don't have to
    // close and re-run.
    const config = readConfig();
    const sessions = [
      {
        name: "Panopto",
        what: "video downloads",
        hosts: videoAuthHosts(config),
        openUrl: String(config.panoptoUrl || "").trim(),
        manual:
          "open your Panopto site (e.g. https://<your-org>.hosted.panopto.com) and sign in",
        tip: 'set "panoptoUrl" in config.json to have it opened for you',
      },
      {
        name: "Study.Net",
        what: "Study.Net materials downloads",
        hosts: studyNetAuthHosts(),
        openUrl: String(config.studyNetUrl || "").trim(),
        manual:
          'open one of your courses and click its "Study.Net Materials" tab (that signs you in to Study.Net)',
        tip: 'set "studyNetUrl" in config.json to have it opened for you',
      },
    ];

    const missing = sessions.filter((s) => !hasCookiesForHosts(cookies, s.hosts));
    if (missing.length) {
      for (const s of missing) {
        const tag = s.name.toUpperCase();
        logger(
          "WARNING",
          tag,
          `No ${s.name} session cookies were captured — ${s.what} may fail without them.`,
          0
        );
        // Auto-open a configured URL so the user only has to sign in; otherwise
        // tell them how to reach the site themselves (with a config tip).
        if (s.openUrl) {
          try {
            const tab = await browser.newPage();
            await tab.goto(s.openUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
            logger("NOTE", tag, `Opened ${s.openUrl} in a new tab — sign in there.`, 0);
          } catch (e) {
            logger("NOTE", tag, `Could not open ${s.openUrl} (${e.message}); ${s.manual} in the same window.`, 0);
          }
        } else {
          logger("NOTE", tag, `To enable it, ${s.manual} in the same Chrome window. (Tip: ${s.tip}.)`, 0);
        }
      }

      await prompt(
        "After signing in to the site(s) above, press Enter to re-check (or press Enter to continue without them)..."
      );
      cookies = (await client.send("Network.getAllCookies")).cookies;

      for (const s of missing) {
        const tag = s.name.toUpperCase();
        if (hasCookiesForHosts(cookies, s.hosts)) {
          logger("NOTE", tag, `${s.name} cookies captured — ${s.what} are set up.`, 0);
        } else {
          logger(
            "WARNING",
            tag,
            `Still no ${s.name} cookies — continuing without it. ${s.what} will be ` +
              "skipped (and reported) when you scrape; see the README to add these " +
              "cookies by hand later.",
            0
          );
        }
      }
    } else {
      logger("NOTE", "LOGIN", "Panopto and Study.Net session cookies detected.", 0);
    }
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

export default {
  runLogin,
  getLoginStrategy,
  LOGIN_STRATEGIES,
  DEFAULT_LOGIN_MODE,
  videoAuthHosts,
  studyNetAuthHosts,
  hasCookiesForHosts,
  hasVideoAuthCookies,
};
