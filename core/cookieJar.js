import fs from "fs";
import path from "path";

/**
 * The cookie jar: one cookies file holding every session the scraper uses
 * (Canvas, Panopto, Study.Net, and any publisher sites the user imports).
 *
 * Cookies arrive from several places — the interactive `login` window, a
 * cookie-export file from any browser, or a browser's own cookie store — so
 * everything that writes the jar goes through mergeCookies(), which refreshes
 * the domains a new batch covers and keeps the rest. A Canvas re-login
 * therefore never wipes imported publisher cookies, and re-importing a
 * publisher replaces its stale cookies.
 */

/** Fields Chrome's CDP sameSite may report that puppeteer's setCookie accepts. */
const VALID_SAME_SITE = new Set(["Strict", "Lax", "None"]);

/**
 * Normalizes a user-typed site ("https://www.economist.com/x", "Economist.com")
 * to a bare registrable-looking host ("economist.com"). A leading "www." is
 * dropped so a site matches its www and non-www cookies alike.
 * @param {string} site
 * @returns {string} normalized host, or "" if nothing usable was given
 */
export function normalizeSite(site) {
  let s = String(site || "").trim().toLowerCase();
  if (!s) return "";
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
  } catch (e) {
    // fall through to the manual clean-up below
  }
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0];
  return s.replace(/^\.+/, "").replace(/^www\./, "");
}

/**
 * Splits a comma/space-separated `--site` value (or an array of them) into
 * normalized, de-duplicated hosts.
 * @param {string|string[]} value
 * @returns {string[]}
 */
export function parseSites(value) {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((v) => String(v || "").split(/[,\s]+/))
    .map(normalizeSite)
    .filter(Boolean);
  return [...new Set(parts)];
}

/** A cookie's domain without the leading dot, lowercased. */
function cookieDomain(c) {
  return String(c && c.domain ? c.domain : "").replace(/^\./, "").toLowerCase();
}

/** Whether a cookie belongs to `site` (the site itself or any subdomain). */
function onSite(c, site) {
  const d = cookieDomain(c);
  return d === site || d.endsWith(`.${site}`);
}

/**
 * Keeps only the cookies that belong to one of `sites` (exact host or a
 * subdomain), so an import never pulls in unrelated sessions.
 * @param {Array<object>} cookies
 * @param {string[]} sites normalized hosts (see parseSites)
 * @returns {Array<object>}
 */
export function filterCookiesForSites(cookies, sites) {
  const wanted = (sites || []).map(normalizeSite).filter(Boolean);
  return (cookies || []).filter((c) => wanted.some((s) => onSite(c, s)));
}

/**
 * The cookies a browser would send to `url`: those whose domain is the URL's
 * host or a parent of it (".economist.com" applies to "www.economist.com").
 * @param {Array<object>} cookies
 * @param {string} url
 * @returns {Array<object>}
 */
export function cookiesForUrl(cookies, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return [];
  }
  return (cookies || []).filter((c) => {
    const d = cookieDomain(c);
    return d && (host === d || host.endsWith(`.${d}`));
  });
}

/** Whether a cookie has a real expiry that is already in the past. */
function isExpired(c, nowSec) {
  return typeof c.expires === "number" && c.expires > 0 && c.expires < nowSec;
}

/**
 * Merges a new batch of cookies into an existing jar. Every existing cookie on
 * a domain the batch covers is replaced (so a fresh login doesn't leave stale
 * cookies with different names behind); cookies on other domains are kept.
 * Expired cookies are dropped from the result.
 * @param {Array<object>} existing cookies already in the jar
 * @param {Array<object>} incoming newly captured/imported cookies
 * @param {number} [nowSec] current time in seconds (for tests)
 * @returns {Array<object>}
 */
export function mergeCookies(existing, incoming, nowSec = Date.now() / 1000) {
  const covered = new Set((incoming || []).map(cookieDomain).filter(Boolean));
  const kept = (existing || []).filter((c) => !covered.has(cookieDomain(c)));
  return [...kept, ...(incoming || [])].filter((c) => !isExpired(c, nowSec));
}

/**
 * Keeps only the fields readCookies()/setCookie care about, in the
 * puppeteer-style shape the rest of the scraper consumes.
 * @param {Array<object>} cookies CDP, Netscape-parsed or browser-store cookies
 * @returns {Array<object>}
 */
export function normalizeCookies(cookies) {
  return (cookies || [])
    .filter((c) => c && c.name && c.domain)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ""),
        domain: String(c.domain),
        path: c.path || "/",
        // -1 marks a session cookie, which is what puppeteer wants.
        expires: typeof c.expires === "number" && c.expires > 0 ? c.expires : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      if (VALID_SAME_SITE.has(c.sameSite)) out.sameSite = c.sameSite;
      return out;
    });
}

/**
 * Writes the jar atomically (temp file + rename), so an interrupted write never
 * leaves a half-written cookies file that breaks the next scrape.
 * @param {string} file destination path
 * @param {Array<object>} cookies
 */
export function writeCookies(file, cookies) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(cookies, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export default {
  normalizeSite,
  parseSites,
  filterCookiesForSites,
  cookiesForUrl,
  mergeCookies,
  normalizeCookies,
  writeCookies,
};
