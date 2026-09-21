import fs from "fs";
import path from "path";

/**
 * Per-course download manifest — the source of truth for what has already been
 * downloaded, so a re-run can skip complete files and re-fetch only what is
 * missing or incomplete.
 *
 * One JSON file lives at the root of each course's folder
 * (`<courseDir>/.scrape-manifest.json`). Each asset is keyed by its normalized
 * source URL (verifier/auth tokens stripped so a rotated link still matches)
 * and records where the bytes actually live (relative to the course folder, so
 * the entry survives a later `--wiki` / `--octarine` relocation) plus enough to
 * tell a complete file from a truncated one:
 *
 *   { url, path, bytes, etag, complete, downloaded, last_seen, state }
 *
 * Like `report`, scraping is fully sequential, so a single "current course"
 * loaded here is safe: it is set before a course's downloads and still holds
 * while they run.
 */

const MANIFEST_FILE = ".scrape-manifest.json";
const MANIFEST_VERSION = 1;

// Query params that identify the requester/session rather than the resource, so
// they rotate between runs. Dropping them keeps the same file matching across
// runs. `x-amz-*` covers S3 presigned-URL signatures.
const VOLATILE_PARAMS = new Set([
  "verifier",
  "sf_verifier",
  "download_frd",
  "access_token",
  "token",
  "wrap",
  "ts",
  "expires",
  "signature",
  "key-pair-id",
]);

/** Lowercases origin/path, drops a trailing slash, and strips volatile params. */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname.replace(/\/+$/, "");
    const params = [...u.searchParams.entries()]
      .filter(([k]) => {
        const lower = k.toLowerCase();
        return !VOLATILE_PARAMS.has(lower) && !lower.startsWith("x-amz-");
      })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const search = params.length
      ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&")
      : "";
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}${search}`;
  } catch (e) {
    return String(url || "").trim().replace(/\/+$/, "");
  }
}

const manifest = {
  // True once a course's manifest is loaded (between load() and reset()).
  enabled: false,
  // --force: re-download matched assets even when the manifest says complete.
  force: false,
  // --prune: delete local files whose source is gone from the course (default
  // keeps them, only flagging the entry state).
  prune: false,
  // ISO timestamp set when this course's manifest is loaded. An asset whose
  // last_seen is older was not referenced this run — its source is gone.
  runStart: "",
  courseDir: "",
  courseUrl: "",
  assets: {},
  // Maps a stable item identity (a normalized item URL, e.g. an assignment's)
  // to the folder it was saved in (relative to courseDir). Lets a re-run find
  // an item's existing folder even when its display name changed — an
  // assignment's grade suffix updates mid-term — so it renames rather than
  // duplicates.
  dirs: {},

  /** Turns force (re-download-even-if-complete) mode on or off. */
  setForce(on) {
    this.force = !!on;
  },

  /** Turns prune (delete files whose source is gone) mode on or off. */
  setPrune(on) {
    this.prune = !!on;
  },

  /**
   * Loads the manifest for a course and makes it current. A missing or
   * unreadable file starts an empty manifest (first scrape of the course).
   * @param {string} courseDir the course's output folder
   * @param {string} courseUrl the course URL (stored for readability)
   */
  load(courseDir, courseUrl) {
    this.courseDir = courseDir;
    this.courseUrl = courseUrl || "";
    this.assets = {};
    this.dirs = {};
    this.enabled = true;
    this.runStart = new Date().toISOString();
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(courseDir, MANIFEST_FILE))
      );
      if (raw && raw.assets && typeof raw.assets === "object") {
        this.assets = raw.assets;
      }
      if (raw && raw.dirs && typeof raw.dirs === "object") {
        this.dirs = raw.dirs;
      }
    } catch (e) {
      // No manifest yet (or unreadable) — start fresh.
    }
  },

  /**
   * Clears current-course state (call after save(), between courses). `force`
   * is a run-level flag (set by runScrape, restored in its finally), so it is
   * deliberately left untouched here.
   */
  reset() {
    this.enabled = false;
    this.courseDir = "";
    this.courseUrl = "";
    this.runStart = "";
    this.assets = {};
    this.dirs = {};
  },

  /** The manifest key for a URL (normalized). */
  key(url) {
    return normalizeUrl(url);
  },

  /** The stored entry for a URL, or undefined. */
  lookup(url) {
    if (!this.enabled || !url) return undefined;
    return this.assets[this.key(url)];
  },

  /**
   * Whether a complete copy of `url` is already on disk and can be skipped.
   * Returns the absolute path when it can be skipped, or null when the caller
   * must (re-)download. A recorded byte count must match the on-disk size (a
   * mismatch means a truncated/altered file); when the size is unknown (no
   * Content-Length was captured), a present file is treated as complete.
   * @param {string} url source URL
   * @returns {string|null} the existing file's absolute path, or null
   */
  completePath(url) {
    if (!this.enabled || this.force || !url) return null;
    const entry = this.assets[this.key(url)];
    if (!entry || !entry.complete || !entry.path) return null;
    const abs = path.join(this.courseDir, entry.path);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      return null; // recorded file is gone — re-download
    }
    if (!stat.isFile()) return null;
    if (entry.bytes && stat.size !== entry.bytes) return null;
    return abs;
  },

  /**
   * Records a completed download (upserts the entry).
   * @param {string} url source URL
   * @param {string} absPath the file that was written
   * @param {object} [opts]
   * @param {number} [opts.bytes] Content-Length at download time (0 = unknown)
   * @param {string} [opts.etag] ETag at download time
   * @param {string} [opts.state] lifecycle state (default "downloaded")
   */
  record(url, absPath, { bytes = 0, etag = "", state = "downloaded" } = {}) {
    if (!this.enabled || !url) return;
    const now = new Date().toISOString();
    const k = this.key(url);
    const prev = this.assets[k] || {};
    this.assets[k] = {
      url,
      path: path.relative(this.courseDir, absPath),
      bytes: bytes || prev.bytes || 0,
      etag: etag || prev.etag || "",
      complete: true,
      downloaded: prev.downloaded || now,
      last_seen: now,
      state,
    };
  },

  /** Refreshes last_seen when an asset is skipped (still present this run). */
  markSeen(url) {
    const entry = this.lookup(url);
    if (entry) entry.last_seen = new Date().toISOString();
  },

  /**
   * The folder recorded for an item identity (relative to courseDir), or
   * undefined. `identity` is a stable item URL (an assignment/module/quiz link).
   */
  lookupDir(identity) {
    if (!this.enabled || !identity) return undefined;
    return this.dirs[this.key(identity)];
  },

  /** Records the folder an item was saved in, keyed by its stable identity. */
  recordDir(identity, absDir) {
    if (!this.enabled || !identity) return;
    this.dirs[this.key(identity)] = path.relative(this.courseDir, absDir);
  },

  /**
   * Rewrites every asset path (and dir registry entry) under `oldRel` to sit
   * under `newRel` instead — used when a folder is renamed in place (e.g. an
   * assignment's grade suffix changed) so a resumed run still finds the files
   * inside rather than re-downloading them. Paths are relative to courseDir.
   * @param {string} oldRel the folder's previous path (relative to courseDir)
   * @param {string} newRel its new path (relative to courseDir)
   */
  relocate(oldRel, newRel) {
    if (!this.enabled || !oldRel || oldRel === newRel) return;
    const oldPrefix = oldRel + path.sep;
    const remap = (p) => {
      if (p === oldRel) return newRel;
      if (p && p.startsWith(oldPrefix)) return newRel + path.sep + p.slice(oldPrefix.length);
      return p;
    };
    for (const k of Object.keys(this.assets)) {
      const e = this.assets[k];
      if (e && e.path) e.path = remap(e.path);
    }
    for (const k of Object.keys(this.dirs)) {
      this.dirs[k] = remap(this.dirs[k]);
    }
  },

  /**
   * Reconciles the manifest against what this run referenced, after a course's
   * selected categories have been scraped. An asset whose last_seen predates
   * this run's start was not referenced — its source is gone from the course
   * (unlike a locked-but-still-listed item, whose file we keep and whose
   * last_seen is refreshed on the skip). Such an asset is flagged
   * `state:"removed"` and kept by default; under --prune its file is deleted
   * and the entry removed.
   *
   * Only entries under a scraped top-level category are considered, so a
   * partial run (e.g. only `-a`) never flags another category's files. A
   * missing/empty `categories` set means "consider everything scraped".
   * @param {Set<string>} [categories] top-level folder names scraped this run
   * @returns {{removed: number, pruned: number}} counts for the caller to log
   */
  reconcile(categories = null) {
    const result = { removed: 0, pruned: 0 };
    if (!this.enabled) return result;
    for (const k of Object.keys(this.assets)) {
      const entry = this.assets[k];
      if (!entry || !entry.path) continue;
      if (categories && categories.size) {
        const top = entry.path.split(path.sep)[0];
        if (!categories.has(top)) continue; // category not scraped this run
      }
      const seen = entry.last_seen && entry.last_seen >= this.runStart;
      if (seen) continue;
      if (this.prune) {
        try {
          fs.rmSync(path.join(this.courseDir, entry.path), { force: true });
        } catch (e) {
          /* best-effort */
        }
        delete this.assets[k];
        result.pruned++;
      } else {
        entry.state = "removed";
        result.removed++;
      }
    }
    return result;
  },

  /** Persists the manifest to `<courseDir>/.scrape-manifest.json` (atomic). */
  save() {
    if (!this.enabled || !this.courseDir) return;
    const out = {
      version: MANIFEST_VERSION,
      course_url: this.courseUrl,
      updated: new Date().toISOString(),
      assets: this.assets,
      dirs: this.dirs,
    };
    const dest = path.join(this.courseDir, MANIFEST_FILE);
    const tmp = dest + ".part";
    try {
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, dest); // atomic — never leave a half-written manifest
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (e2) {
        /* ignore */
      }
    }
  },
};

export { MANIFEST_FILE, normalizeUrl };
export default manifest;
