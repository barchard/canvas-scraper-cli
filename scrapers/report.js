import fs from "fs";
import path from "path";

/**
 * Accumulates a row for every asset the scraper downloads so it can be written
 * out as a CSV at the end of the run (enabled via the --report flag).
 *
 * Scraping is fully sequential (one course, then one asset, at a time — every
 * call site awaits), so a single module-level "current course" is safe: the
 * course context set before a course's downloads still holds while they run.
 */
const report = {
  enabled: false,
  rows: [],
  skipped: [],
  // Accessible artifacts/articles recorded during a --dry-run probe (no bytes
  // are downloaded, so these can't be captured via record()/statSync).
  available: [],
  // Index into `skipped` keyed by url+course, so the same asset attempted more
  // than once in a run (e.g referenced from several modules) yields one row.
  skippedIndex: new Map(),
  // Same idea for `available`: one row per url+course.
  availableIndex: new Map(),
  // Errors encountered during a run (every helpers.print("ERROR", ...) line).
  // Tracked independently of `enabled` so errors are always available to write
  // to errors.csv, even without --report.
  errors: [],
  // Rich, structured snapshots captured when a download fails despite the item
  // being reachable by hand (e.g an HBSP LTI launch). Unlike the one-line
  // skip/failure reason, each entry records the page state at the point of
  // failure — landed URL, HTTP status, page title/text, and per-frame form and
  // POST details — so the scraper can be updated to handle the case. Always on
  // (not gated by `enabled`) and written to download-diagnostics.jsonl.
  diagnostics: [],
  current: { courseName: "", courseUrl: "" },

  /** Turns recording on. No-op recorders stay cheap when the flag is off. */
  enable() {
    this.enabled = true;
  },

  /** Sets the course every subsequent recorded asset is attributed to. */
  setCourse(courseName, courseUrl) {
    this.current = {
      courseName: courseName || "",
      courseUrl: courseUrl || "",
    };
  },

  /**
   * Records one downloaded asset. `filePath` is the file on disk (its size and
   * type are read from there); `originalUrl` is where the asset came from. Files
   * that never made it to disk are skipped.
   * @param {string} filePath absolute or relative path to the saved file
   * @param {string} originalUrl source URL of the asset
   */
  record(filePath, originalUrl) {
    if (!this.enabled) return;
    let size;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
      size = stat.size;
    } catch (e) {
      return; // not written (failed/partial download) — nothing to report
    }
    const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
    this.rows.push({
      file: path.basename(filePath),
      type: ext || "unknown",
      sizeBytes: size,
      sizeHuman: humanSize(size),
      courseName: this.current.courseName,
      courseUrl: this.current.courseUrl,
      originalUrl: originalUrl || "",
    });
  },

  /**
   * Records an asset that was skipped or failed to download, with the source URL
   * and (best-effort) reason. Attributed to the current course, like record().
   * @param {string} url source URL of the asset that could not be downloaded
   * @param {string} [reason] short description of why it was skipped/failed
   * @param {object} [opts]
   * @param {string} [opts.destDir] the folder the scraper would have saved the
   *   file into. Recorded so the manual importer can place a hand-obtained copy
   *   exactly where the scraper would have put it.
   */
  recordFailure(url, reason, opts = {}) {
    if (!this.enabled) return;
    reason = reason || "";
    const destDir = opts.destDir || "";
    const key = `${url || ""}\n${this.current.courseUrl}`;
    const existing = this.skippedIndex.get(key);
    if (existing) {
      // Same asset seen again: keep it as one row, but upgrade a generic reason
      // (e.g "download failed") if a later attempt produced a specific one, and
      // fill in a destination the first attempt didn't have.
      if (isGenericReason(existing.reason) && !isGenericReason(reason)) {
        existing.reason = reason;
      }
      if (!existing.destDir && destDir) existing.destDir = destDir;
      return;
    }
    const row = {
      url: url || "",
      reason,
      destDir,
      courseName: this.current.courseName,
      courseUrl: this.current.courseUrl,
    };
    this.skippedIndex.set(key, row);
    this.skipped.push(row);
  },

  /**
   * Records an artifact/article that a --dry-run probe found to be accessible
   * (it would have downloaded successfully). Attributed to the current course,
   * like record(). Deduped per url+course so an item referenced from several
   * places yields one row. `kind` is a short label (e.g "file", "page", "video").
   * @param {string} url source URL of the accessible asset
   * @param {string} [kind] short description of the asset kind
   */
  recordAvailable(url, kind) {
    if (!this.enabled) return;
    const key = `${url || ""}\n${this.current.courseUrl}`;
    if (this.availableIndex.has(key)) return;
    const row = {
      url: url || "",
      kind: kind || "",
      courseName: this.current.courseName,
      courseUrl: this.current.courseUrl,
    };
    this.availableIndex.set(key, row);
    this.available.push(row);
  },

  /**
   * Records an error raised during the run so it can be written to errors.csv and
   * tracked/resolved later. Always on (not gated by `enabled`): error tracking
   * shouldn't require --report. Attributed to the current course, like record().
   * @param {object} fields
   * @param {string} [fields.name] the item the error is about (e.g "ASSIGNMENT 'X'")
   * @param {string} [fields.message] the short error message that was logged
   * @param {string} [fields.detail] the underlying error message
   * @param {string} [fields.errorType] the error class (e.g "TimeoutError")
   * @param {string} [fields.stack] the full stack trace (file + line), if any
   */
  recordError({ name, message, detail, errorType, stack } = {}) {
    this.errors.push({
      time: new Date().toISOString(),
      name: name || "",
      message: message || "",
      detail: detail || "",
      errorType: errorType || "",
      stack: stack || "",
      courseName: this.current.courseName,
      courseUrl: this.current.courseUrl,
    });
  },

  /**
   * Records a rich diagnostic snapshot for a download that failed even though
   * the item may be completable by hand. Always on (like recordError): these
   * exist to make an unreproducible-looking failure fixable. `entry` is an
   * arbitrary structured object describing what the scraper saw at the point of
   * failure; it's tagged with a timestamp and the current course.
   * @param {object} entry structured diagnostic fields (kind, url, outcome, …)
   */
  recordDiagnostic(entry = {}) {
    this.diagnostics.push({
      time: new Date().toISOString(),
      courseName: this.current.courseName,
      courseUrl: this.current.courseUrl,
      ...entry,
    });
  },

  /**
   * Records every file that appeared under `dir` between `before` and now. Used
   * for yt-dlp downloads, where the exact output filenames (and playlist
   * subfolders) aren't known ahead of time.
   * @param {string} dir directory the download wrote into
   * @param {Set<string>} before file paths present before the download
   * @param {string} originalUrl source URL of the asset(s)
   */
  recordNewFiles(dir, before, originalUrl) {
    if (!this.enabled) return;
    for (const file of listFilesRecursive(dir)) {
      if (!before.has(file)) this.record(file, originalUrl);
    }
  },

  /**
   * Snapshots the files currently under `dir` (recursively). Pair with
   * recordNewFiles to capture whatever a download adds.
   * @param {string} dir
   * @returns {Set<string>}
   */
  snapshot(dir) {
    if (!this.enabled) return new Set();
    return new Set(listFilesRecursive(dir));
  },

  /**
   * Writes the accumulated rows to `filePath` as CSV. No-op if disabled or empty.
   * @param {string} filePath where to write the CSV
   * @returns {number} number of asset rows written
   */
  write(filePath) {
    if (!this.enabled) return 0;
    const header = [
      "file",
      "type",
      "size_bytes",
      "size",
      "course_name",
      "course_url",
      "original_url",
    ];
    const lines = [header.map(csvField).join(",")];
    for (const r of this.rows) {
      lines.push(
        [
          r.file,
          r.type,
          r.sizeBytes,
          r.sizeHuman,
          r.courseName,
          r.courseUrl,
          r.originalUrl,
        ]
          .map(csvField)
          .join(",")
      );
    }
    fs.writeFileSync(filePath, lines.join("\r\n") + "\r\n");
    return this.rows.length;
  },

  /**
   * Writes the skipped/failed assets to `filePath` as CSV. No-op if disabled or
   * empty (returns 0, so the caller can avoid writing an empty file).
   * @param {string} filePath where to write the CSV
   * @returns {number} number of skipped/failed rows written
   */
  writeSkipped(filePath) {
    if (!this.enabled || !this.skipped.length) return 0;
    const header = ["url", "reason", "dest_dir", "course_name", "course_url"];
    const lines = [header.map(csvField).join(",")];
    for (const r of this.skipped) {
      lines.push(
        [r.url, r.reason, r.destDir || "", r.courseName, r.courseUrl]
          .map(csvField)
          .join(",")
      );
    }
    fs.writeFileSync(filePath, lines.join("\r\n") + "\r\n");
    return this.skipped.length;
  },

  /**
   * Writes the errors encountered during the run to `filePath` as CSV. No-op
   * (returns 0) when no errors were recorded, so the caller can skip an empty
   * file. Not gated by `enabled` — errors are always tracked.
   * @param {string} filePath where to write the CSV
   * @returns {number} number of error rows written
   */
  writeErrors(filePath) {
    if (!this.errors.length) return 0;
    const header = [
      "time",
      "item",
      "error",
      "error_type",
      "detail",
      "course_name",
      "course_url",
      "stack",
    ];
    const lines = [header.map(csvField).join(",")];
    for (const e of this.errors) {
      lines.push(
        [
          e.time,
          e.name,
          e.message,
          e.errorType,
          e.detail,
          e.courseName,
          e.courseUrl,
          e.stack,
        ]
          .map(csvField)
          .join(",")
      );
    }
    fs.writeFileSync(filePath, lines.join("\r\n") + "\r\n");
    return this.errors.length;
  },

  /**
   * Writes the captured diagnostic snapshots to `filePath` as JSON Lines (one
   * JSON object per line). No-op (returns 0) when nothing was captured, so the
   * caller can skip an empty file. Not gated by `enabled` — diagnostics are
   * always tracked. JSONL (not CSV) because entries are nested and hold long
   * free-text (page titles, body snippets, per-frame details).
   * @param {string} filePath where to write the JSONL
   * @returns {number} number of diagnostic entries written
   */
  writeDiagnostics(filePath) {
    if (!this.diagnostics.length) return 0;
    const lines = this.diagnostics.map((d) => JSON.stringify(d));
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    return this.diagnostics.length;
  },

  /**
   * Writes the combined --dry-run accessibility report to `filePath` as CSV:
   * every probed artifact/article with a `status` of "inaccessible" or
   * "accessible". Inaccessible rows are listed first (they're what a dry-run is
   * for) and carry the reason they couldn't be downloaded.
   * @param {string} filePath where to write the CSV
   * @returns {{total: number, inaccessible: number, accessible: number}}
   */
  writeDryRun(filePath) {
    const header = ["status", "kind", "url", "reason", "course_name", "course_url"];
    const lines = [header.map(csvField).join(",")];
    for (const r of this.skipped) {
      lines.push(
        ["inaccessible", "", r.url, r.reason, r.courseName, r.courseUrl]
          .map(csvField)
          .join(",")
      );
    }
    for (const r of this.available) {
      lines.push(
        ["accessible", r.kind, r.url, "", r.courseName, r.courseUrl]
          .map(csvField)
          .join(",")
      );
    }
    fs.writeFileSync(filePath, lines.join("\r\n") + "\r\n");
    return {
      total: this.skipped.length + this.available.length,
      inaccessible: this.skipped.length,
      accessible: this.available.length,
    };
  },
};

/**
 * Whether a skip reason is a vague catch-all (so a more specific reason seen for
 * the same asset later should replace it).
 */
function isGenericReason(reason) {
  return /^(\s*|download failed|download error|HTTP \d+)\s*$/i.test(reason || "");
}

/** Formats a byte count as B/KB/MB/GB/TB with two decimals above bytes. */
function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(2)} ${units[i]}`;
}

/** Escapes a value for CSV (quotes it when it contains a comma, quote, or newline). */
function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Lists every file under `dir` recursively, returning full paths. */
function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export default report;
