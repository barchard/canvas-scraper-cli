import fs from "fs";
import os from "os";
import path from "path";

/**
 * Reads cookies straight out of a Firefox profile, on macOS, Windows and Linux.
 *
 * Firefox keeps cookies unencrypted in `<profile>/cookies.sqlite`, inside the
 * user's own profile folder, so this needs no OS permission prompt (unlike
 * Safari's container, which macOS guards behind Full Disk Access, or Chrome's
 * encrypted store). The database is copied to a temp folder first — together
 * with its write-ahead log, which holds recent logins — so it can be read while
 * Firefox is running and the user's profile is never written to.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.13+ / 24), so the standalone
 * builds need no native addon.
 */

/** Candidate Firefox data roots (each holding a profiles.ini) for a platform. */
export function firefoxRoots(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Firefox")];
  }
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Mozilla", "Firefox")];
  }
  return [
    path.join(home, ".mozilla", "firefox"),
    path.join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    path.join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
  ];
}

/**
 * Parses profiles.ini into its sections.
 * @param {string} text
 * @returns {Array<{section: string, values: object}>}
 */
export function parseProfilesIni(text) {
  const sections = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      cur = { section: m[1], values: {} };
      sections.push(cur);
      continue;
    }
    const eq = line.indexOf("=");
    if (cur && eq > 0) cur.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

/**
 * Lists the profiles in a Firefox root, marking the one Firefox opens by
 * default (the `[Install…]` section's Default, else the `Default=1` profile).
 * @param {string} root folder containing profiles.ini
 * @param {string} iniText contents of profiles.ini
 * @returns {Array<{name: string, dir: string, isDefault: boolean}>}
 */
export function listProfiles(root, iniText) {
  const sections = parseProfilesIni(iniText);
  const installDefault = sections
    .filter((s) => s.section.startsWith("Install") && s.values.Default)
    .map((s) => s.values.Default)[0];
  const resolve = (v) =>
    v.IsRelative === "0" ? v.Path : path.join(root, ...String(v.Path).split("/"));
  const profiles = sections
    .filter((s) => s.section.startsWith("Profile") && s.values.Path)
    .map((s) => ({
      name: s.values.Name || path.basename(s.values.Path),
      dir: resolve(s.values),
      rel: s.values.Path,
      flagged: s.values.Default === "1",
    }));
  return profiles.map((p) => ({
    name: p.name,
    dir: p.dir,
    isDefault: installDefault ? p.rel === installDefault : p.flagged,
  }));
}

/**
 * Finds the Firefox profile folder to read.
 * @param {object} [opts]
 * @param {string} [opts.profile] profile name, folder name, or absolute path
 * @param {string[]} [opts.roots] override the data roots (for tests)
 * @returns {string} absolute profile folder containing cookies.sqlite
 * @throws {Error} with guidance when Firefox or the profile can't be found
 */
export function findFirefoxProfile(opts = {}) {
  const { profile } = opts;
  if (profile && path.isAbsolute(profile) && fs.existsSync(path.join(profile, "cookies.sqlite"))) {
    return profile;
  }
  const roots = opts.roots || firefoxRoots();
  const all = [];
  for (const root of roots) {
    const ini = path.join(root, "profiles.ini");
    if (!fs.existsSync(ini)) continue;
    let text;
    try {
      text = fs.readFileSync(ini, "utf8");
    } catch (e) {
      if (e.code === "EPERM" || e.code === "EACCES") {
        throw new Error(
          `Permission denied reading Firefox's profile folder (${root}). Run the command from a ` +
            "normal terminal, or use `canvas-scraper login --site <site>` instead."
        );
      }
      throw e;
    }
    all.push(...listProfiles(root, text));
  }
  const usable = all.filter((p) => fs.existsSync(path.join(p.dir, "cookies.sqlite")));
  if (!usable.length) {
    throw new Error(
      "No Firefox profile with cookies was found. Sign in to the site in Firefox first, " +
        "or use `canvas-scraper login --site <site>` instead."
    );
  }
  if (profile) {
    const want = profile.toLowerCase();
    const hit = usable.find(
      (p) => p.name.toLowerCase() === want || path.basename(p.dir).toLowerCase() === want
    );
    if (!hit) {
      throw new Error(
        `Firefox profile "${profile}" not found. Available: ${usable.map((p) => p.name).join(", ")}.`
      );
    }
    return hit.dir;
  }
  return (usable.find((p) => p.isDefault) || usable[0]).dir;
}

/** Firefox's sameSite column: 1 = Lax, 2 = Strict; anything else is left unset. */
function sameSite(v) {
  if (Number(v) === 1) return "Lax";
  if (Number(v) === 2) return "Strict";
  return undefined;
}

/**
 * Converts a moz_cookies row to a puppeteer-style cookie. Newer Firefox
 * releases store `expiry` in milliseconds rather than seconds; anything too
 * large to be seconds is scaled down.
 */
export function rowToCookie(row) {
  let expires = Number(row.expiry);
  if (Number.isFinite(expires) && expires > 1e11) expires = Math.floor(expires / 1000);
  const out = {
    name: row.name,
    value: row.value,
    domain: row.host,
    path: row.path || "/",
    expires: Number.isFinite(expires) && expires > 0 ? expires : -1,
    httpOnly: !!Number(row.isHttpOnly),
    secure: !!Number(row.isSecure),
  };
  const ss = sameSite(row.sameSite);
  if (ss) out.sameSite = ss;
  return out;
}

/** Loads node:sqlite, with a clear message on a Node that lacks it. */
async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch (e) {
    throw new Error(
      `Reading Firefox cookies needs Node 22.13 or newer (this is ${process.version}). ` +
        "Use `canvas-scraper login --site <site>` or a cookie-export file instead."
    );
  }
}

/**
 * Reads every cookie from a Firefox profile (callers filter by site).
 * @param {object} [opts]
 * @param {string} [opts.profile] profile name, folder name, or absolute path
 * @param {string[]} [opts.roots] override the data roots (for tests)
 * @returns {Promise<{profileDir: string, cookies: Array<object>}>}
 */
export async function readFirefoxCookies(opts = {}) {
  const profileDir = findFirefoxProfile(opts);
  const { DatabaseSync } = await loadSqlite();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-scraper-ff-"));
  try {
    const db = path.join(tmp, "cookies.sqlite");
    fs.copyFileSync(path.join(profileDir, "cookies.sqlite"), db);
    // The WAL holds writes Firefox hasn't checkpointed yet — often the login
    // the user just made — so copy it alongside for SQLite to replay.
    const wal = path.join(profileDir, "cookies.sqlite-wal");
    if (fs.existsSync(wal)) fs.copyFileSync(wal, `${db}-wal`);
    const conn = new DatabaseSync(db);
    try {
      const rows = conn
        .prepare("SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies")
        .all();
      return { profileDir, cookies: rows.map(rowToCookie) };
    } finally {
      conn.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export default { readFirefoxCookies, findFirefoxProfile, listProfiles, parseProfilesIni, firefoxRoots, rowToCookie };
