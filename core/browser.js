import puppeteer from "puppeteer";

import helpers from "../scrapers/helpers.js";

/**
 * Launches Chrome for either a headless scrape or an interactive login.
 *
 * Prefers the locally installed Google Chrome (the "chrome" channel) because
 * Puppeteer's bundled Chromium is pinned to an older build that crashes on
 * launch under newer macOS releases. If no local Chrome is installed, falls
 * back to the bundled browser.
 *
 * @param {object} [opts]
 * @param {boolean|"new"} [opts.headless="new"] headless mode. Pass `false` for
 *   a visible, interactive window (used by the login flow).
 * @param {string} [opts.userDataDir] persistent profile directory. Left unset
 *   today (the "fresh" login strategy uses a throwaway profile); reserved so a
 *   future persistent-profile strategy can keep the user signed in across runs.
 * @returns {Promise<import("puppeteer").Browser>}
 */
export async function launchBrowser(opts = {}) {
  const { headless = "new", userDataDir } = opts;
  const base = { headless };
  if (userDataDir) base.userDataDir = userDataDir;

  try {
    return await puppeteer.launch({ ...base, channel: "chrome" });
  } catch (e) {
    helpers.print(
      "NOTE",
      "BROWSER",
      "Local Google Chrome not found; using Puppeteer's bundled browser.",
      0
    );
    return await puppeteer.launch(base);
  }
}

export default { launchBrowser };
