import fs from "fs";

import { readCookies } from "./scrape.js";
import { readFirefoxCookies } from "./browserCookies/firefox.js";
import {
  filterCookiesForSites,
  mergeCookies,
  normalizeCookies,
  parseSites,
  writeCookies,
} from "./cookieJar.js";
import helpers from "../scrapers/helpers.js";

/**
 * `canvas-scraper cookies import`: adds a publisher's cookies (e.g. The
 * Economist) to the cookie jar from a source the user already has, on any OS:
 *
 *   - a cookie-export file from any browser's extension (JSON or cookies.txt)
 *   - `--browser firefox`, read straight from the Firefox profile
 *
 * Only cookies for the requested `--site`s are taken, so a full-browser export
 * never ends up in the jar. The rest of the jar (Canvas, Panopto, …) is kept.
 */

/** Browsers whose stores can be read directly, without OS permission prompts. */
export const BROWSER_READERS = {
  firefox: readFirefoxCookies,
};

/** Reads the existing jar, or [] when there is none yet. */
export function readJarIfPresent(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return readCookies(file);
  } catch (e) {
    throw new Error(
      `${file} exists but couldn't be read (${e.message}). Fix or move it, then import again.`
    );
  }
}

/**
 * Imports cookies for `sites` into the jar.
 * @param {object} opts
 * @param {string} [opts.file] cookie-export file (JSON or Netscape)
 * @param {string} [opts.browser] browser store to read instead ("firefox")
 * @param {string} [opts.profile] browser profile name/folder/path
 * @param {string|string[]} opts.sites sites to import (comma-separated ok)
 * @param {string} [opts.cookies="cookies.json"] the jar to merge into
 * @param {object} [deps] injectable readers (for tests)
 * @returns {Promise<{imported: number, perSite: object, jar: string}>}
 */
export async function importCookies(opts = {}, deps = {}) {
  const sites = parseSites(opts.sites);
  if (!sites.length) {
    throw new Error("Pass --site <site> (e.g. --site economist.com) to choose which cookies to import.");
  }
  if (!!opts.file === !!opts.browser) {
    throw new Error("Give either a cookie-export file or --browser <name>, not both or neither.");
  }

  let source;
  let all;
  if (opts.file) {
    source = opts.file;
    all = (deps.readFile || readCookies)(opts.file);
  } else {
    const name = String(opts.browser).toLowerCase();
    const reader = (deps.browsers || BROWSER_READERS)[name];
    if (!reader) {
      throw new Error(
        `Reading cookies directly from "${opts.browser}" isn't supported. Supported: ${Object.keys(
          deps.browsers || BROWSER_READERS
        ).join(", ")}. For other browsers, sign in with \`canvas-scraper login --site <site>\` ` +
          "or export the site's cookies with a browser extension and import that file."
      );
    }
    const res = await reader({ profile: opts.profile });
    source = `${name} (${res.profileDir})`;
    all = res.cookies;
  }

  const picked = normalizeCookies(filterCookiesForSites(all, sites));
  const perSite = Object.fromEntries(
    sites.map((s) => [s, filterCookiesForSites(picked, [s]).length])
  );
  const missing = sites.filter((s) => !perSite[s]);
  if (!picked.length) {
    throw new Error(
      `No cookies for ${sites.join(", ")} found in ${source}. Make sure you're signed in to the ` +
        "site there (and, for a browser store, that it has saved them — reloading the site helps)."
    );
  }

  const jar = opts.cookies || "cookies.json";
  const merged = mergeCookies(readJarIfPresent(jar), picked);
  writeCookies(jar, merged);

  for (const s of sites) {
    if (perSite[s]) {
      helpers.print("NOTE", "COOKIES", `Imported ${perSite[s]} cookie(s) for ${s} from ${source}.`, 0);
    }
  }
  for (const s of missing) {
    helpers.print("WARNING", "COOKIES", `No cookies for ${s} found in ${source}; skipped.`, 0);
  }
  helpers.print("NOTE", "COOKIES", `Saved ${merged.length} cookie(s) to ${jar}.`, 0);
  return { imported: picked.length, perSite, jar };
}

export default { importCookies, readJarIfPresent, BROWSER_READERS };
