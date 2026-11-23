import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  normalizeSite,
  parseSites,
  filterCookiesForSites,
  cookiesForUrl,
  mergeCookies,
  normalizeCookies,
  writeCookies,
} from "../core/cookieJar.js";
import {
  parseProfilesIni,
  listProfiles,
  findFirefoxProfile,
  rowToCookie,
  readFirefoxCookies,
  firefoxRoots,
} from "../core/browserCookies/firefox.js";
import { importCookies } from "../core/cookieImport.js";
import { paywallReason } from "../scrapers/paywall.js";
import helpers from "../scrapers/helpers.js";

helpers.setPrinter(() => {});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cookie-import-test-"));
}

const canvas = { name: "canvas_session", value: "c", domain: "canvas.example.edu", path: "/", expires: -1 };
const econ = { name: "session", value: "e", domain: ".economist.com", path: "/", expires: -1 };
const econWww = { name: "pref", value: "w", domain: "www.economist.com", path: "/", expires: -1 };
const other = { name: "x", value: "y", domain: ".example.com", path: "/", expires: -1 };

// ── cookieJar ─────────────────────────────────────────────────────────────

test("normalizeSite strips scheme, www, path and case", () => {
  assert.equal(normalizeSite("https://www.Economist.com/finance/2026/x"), "economist.com");
  assert.equal(normalizeSite("economist.com"), "economist.com");
  assert.equal(normalizeSite(".economist.com"), "economist.com");
  assert.equal(normalizeSite("nytimes.com:443"), "nytimes.com");
  assert.equal(normalizeSite(""), "");
});

test("parseSites splits commas/spaces and de-duplicates", () => {
  assert.deepEqual(parseSites("economist.com, www.economist.com nytimes.com"), [
    "economist.com",
    "nytimes.com",
  ]);
  assert.deepEqual(parseSites(["wsj.com", "ft.com"]), ["wsj.com", "ft.com"]);
  assert.deepEqual(parseSites(undefined), []);
});

test("filterCookiesForSites keeps the site and its subdomains only", () => {
  const got = filterCookiesForSites([canvas, econ, econWww, other], ["economist.com"]);
  assert.deepEqual(got, [econ, econWww]);
  // a lookalike domain is not a subdomain
  assert.deepEqual(filterCookiesForSites([{ domain: "noteconomist.com" }], ["economist.com"]), []);
});

test("cookiesForUrl returns the cookies a browser would send", () => {
  const jar = [canvas, econ, econWww, other];
  assert.deepEqual(cookiesForUrl(jar, "https://www.economist.com/a"), [econ, econWww]);
  // a www-only cookie isn't sent to the bare domain
  assert.deepEqual(cookiesForUrl(jar, "https://economist.com/a"), [econ]);
  assert.deepEqual(cookiesForUrl(jar, "not a url"), []);
});

test("mergeCookies replaces covered domains and keeps the rest", () => {
  const stale = { ...econ, name: "old", value: "stale" };
  const fresh = { ...econ, value: "fresh" };
  const merged = mergeCookies([canvas, stale, econWww], [fresh]);
  // .economist.com is covered → its stale cookie goes; www.economist.com is a
  // different domain and is kept, as is Canvas.
  assert.deepEqual(merged, [canvas, econWww, fresh]);
});

test("a Canvas re-login keeps imported publisher cookies", () => {
  const newCanvas = { ...canvas, value: "new" };
  assert.deepEqual(mergeCookies([canvas, econ], [newCanvas]), [econ, newCanvas]);
});

test("mergeCookies drops expired cookies", () => {
  const expired = { ...other, expires: 100 };
  const live = { ...canvas, expires: 5000 };
  assert.deepEqual(mergeCookies([expired], [live], 1000), [live]);
});

test("normalizeCookies keeps puppeteer fields and valid sameSite only", () => {
  const [c] = normalizeCookies([
    { name: "a", value: 1, domain: "x.com", expires: 0, sameSite: "Bogus", extra: true, httpOnly: 1 },
  ]);
  assert.deepEqual(c, {
    name: "a",
    value: "1",
    domain: "x.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
  });
  assert.equal(normalizeCookies([{ name: "a", domain: "x.com", sameSite: "Lax" }])[0].sameSite, "Lax");
  assert.deepEqual(normalizeCookies([{ value: "no name" }]), []);
});

test("writeCookies writes JSON and leaves no temp file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "cookies.json");
  writeCookies(file, [econ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [econ]);
  assert.deepEqual(fs.readdirSync(dir), ["cookies.json"]);
});

// ── Firefox reader ────────────────────────────────────────────────────────

const INI = `[Install4F96D1932A9F858E]
Default=Profiles/abc.default-release
Locked=1

[Profile1]
Name=default
IsRelative=1
Path=Profiles/xyz.default
Default=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/abc.default-release
`;

test("parseProfilesIni reads sections and keys", () => {
  const s = parseProfilesIni(INI);
  assert.equal(s.length, 3);
  assert.equal(s[1].values.Path, "Profiles/xyz.default");
});

test("listProfiles prefers the [Install] default over Default=1", () => {
  const ps = listProfiles("/ff", INI);
  const def = ps.find((p) => p.isDefault);
  assert.equal(def.name, "default-release");
  assert.equal(def.dir, path.join("/ff", "Profiles", "abc.default-release"));
});

test("firefoxRoots covers macOS, Windows and Linux (incl. snap/flatpak)", () => {
  assert.match(firefoxRoots("darwin", {}, "/h")[0], /Application Support/);
  assert.equal(
    firefoxRoots("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")[0],
    path.join("C:\\Users\\u\\AppData\\Roaming", "Mozilla", "Firefox")
  );
  const linux = firefoxRoots("linux", {}, "/h");
  assert.equal(linux.length, 3);
  assert.ok(linux.some((r) => r.includes("snap")));
});

test("rowToCookie maps flags, sameSite and millisecond expiry", () => {
  const c = rowToCookie({
    name: "session",
    value: "v",
    host: ".economist.com",
    path: "/",
    expiry: 1893456000000, // ms
    isSecure: 1,
    isHttpOnly: 1,
    sameSite: 1,
  });
  assert.deepEqual(c, {
    name: "session",
    value: "v",
    domain: ".economist.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  assert.equal(rowToCookie({ name: "a", value: "", host: "x", expiry: 1893456000, sameSite: 0 }).expires, 1893456000);
  assert.equal(rowToCookie({ name: "a", value: "", host: "x", expiry: 0, sameSite: 0 }).sameSite, undefined);
});

/** Builds a fake Firefox root with one profile holding a cookies.sqlite. */
async function fakeFirefox(rows) {
  const { DatabaseSync } = await import("node:sqlite");
  const root = tmpDir();
  const prof = path.join(root, "Profiles", "abc.default-release");
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(root, "profiles.ini"), INI);
  const db = new DatabaseSync(path.join(prof, "cookies.sqlite"));
  db.exec(
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)"
  );
  const ins = db.prepare(
    "INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const r of rows) ins.run(r.name, r.value, r.host, "/", r.expiry ?? 0, 1, 0, 0);
  db.close();
  return { root, prof };
}

test("readFirefoxCookies reads the default profile from a copy", async () => {
  const { root, prof } = await fakeFirefox([
    { name: "session", value: "e", host: ".economist.com" },
    { name: "other", value: "o", host: ".example.com" },
  ]);
  const before = fs.readdirSync(prof).sort();
  const { profileDir, cookies } = await readFirefoxCookies({ roots: [root] });
  assert.equal(profileDir, prof);
  assert.deepEqual(cookies.map((c) => c.domain).sort(), [".economist.com", ".example.com"]);
  // the user's profile folder is never written to
  assert.deepEqual(fs.readdirSync(prof).sort(), before);
});

test("findFirefoxProfile explains a missing Firefox and an unknown profile", async () => {
  assert.throws(() => findFirefoxProfile({ roots: [tmpDir()] }), /No Firefox profile/);
  const { root } = await fakeFirefox([]);
  assert.throws(() => findFirefoxProfile({ roots: [root], profile: "nope" }), /Available: default-release/);
});

// ── importCookies ─────────────────────────────────────────────────────────

test("importCookies from a file keeps only the requested site and merges", async () => {
  const dir = tmpDir();
  const exportFile = path.join(dir, "export.json");
  const jar = path.join(dir, "cookies.json");
  fs.writeFileSync(exportFile, JSON.stringify([econ, other]));
  fs.writeFileSync(jar, JSON.stringify([canvas]));

  const res = await importCookies({ file: exportFile, sites: "economist.com", cookies: jar });
  assert.equal(res.imported, 1);
  const saved = JSON.parse(fs.readFileSync(jar, "utf8"));
  assert.deepEqual(saved.map((c) => c.domain), ["canvas.example.edu", ".economist.com"]);
});

test("importCookies reads a Netscape cookies.txt export", async () => {
  const dir = tmpDir();
  const txt = path.join(dir, "cookies.txt");
  fs.writeFileSync(txt, "# Netscape HTTP Cookie File\n.economist.com\tTRUE\t/\tTRUE\t0\tsession\tabc\n");
  const jar = path.join(dir, "cookies.json");
  await importCookies({ file: txt, sites: "economist.com", cookies: jar });
  assert.equal(JSON.parse(fs.readFileSync(jar, "utf8"))[0].value, "abc");
});

test("importCookies uses a browser reader and creates the jar", async () => {
  const dir = tmpDir();
  const jar = path.join(dir, "cookies.json");
  const browsers = { firefox: async () => ({ profileDir: "/p", cookies: [econ, other] }) };
  await importCookies({ browser: "Firefox", sites: ["economist.com"], cookies: jar }, { browsers });
  assert.deepEqual(JSON.parse(fs.readFileSync(jar, "utf8")).map((c) => c.domain), [".economist.com"]);
});

test("importCookies refuses without --site, with both/neither source, or an unsupported browser", async () => {
  await assert.rejects(importCookies({ file: "x" }), /--site/);
  await assert.rejects(importCookies({ sites: "economist.com" }), /either/);
  await assert.rejects(importCookies({ file: "x", browser: "firefox", sites: "economist.com" }), /either/);
  await assert.rejects(importCookies({ browser: "safari", sites: "economist.com" }), /login --site/);
});

test("importCookies fails clearly when the site has no cookies, leaving the jar alone", async () => {
  const dir = tmpDir();
  const jar = path.join(dir, "cookies.json");
  fs.writeFileSync(jar, JSON.stringify([canvas]));
  const browsers = { firefox: async () => ({ profileDir: "/p", cookies: [other] }) };
  await assert.rejects(
    importCookies({ browser: "firefox", sites: "economist.com", cookies: jar }, { browsers }),
    /No cookies for economist.com/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(jar, "utf8")), [canvas]);
});

// ── paywall reason ────────────────────────────────────────────────────────

test("paywallReason says needs-login without cookies and expired with them", () => {
  const p = { confidence: "high", reason: "paywall element present (#paywall)" };
  const url = "https://www.economist.com/finance/2026/01/01/x";
  const none = paywallReason(p, { url, hasCookies: false });
  assert.match(none, /needs login/);
  assert.match(none, /canvas-scraper login --site economist\.com/);
  const some = paywallReason(p, { url, hasCookies: true });
  assert.match(some, /session expired/);
  assert.match(paywallReason(p, { url: "https://www.example.com/a", hasCookies: false }), /--site example\.com/);
});
