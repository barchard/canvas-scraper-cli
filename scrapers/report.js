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
   */
  recordFailure(url, reason) {
    if (!this.enabled) return;
    this.skipped.push({
      url: url || "",
      reason: reason || "",
      courseName: this.current.courseName,
      courseUrl: this.current.courseUrl,
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
    const header = ["url", "reason", "course_name", "course_url"];
    const lines = [header.map(csvField).join(",")];
    for (const r of this.skipped) {
      lines.push(
        [r.url, r.reason, r.courseName, r.courseUrl].map(csvField).join(",")
      );
    }
    fs.writeFileSync(filePath, lines.join("\r\n") + "\r\n");
    return this.skipped.length;
  },
};

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
