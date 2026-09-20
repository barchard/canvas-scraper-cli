import fs from "fs";
import path from "path";

import helpers from "../scrapers/helpers.js";
import report from "../scrapers/report.js";
import wiki from "../scrapers/wiki.js";
import octarine from "../scrapers/octarine.js";

/**
 * Manual content importer.
 *
 * Some course material can't be pulled automatically but is trivially obtained
 * by hand — the clearest case being Harvard Business Publishing readings behind
 * a Canvas LTI launch (`…/external_tools/retrieve?url=…hbsp.harvard.edu…`),
 * which open fine in a browser but can fail the headless download. Those land in
 * `report-skipped.csv` (and `download-diagnostics.jsonl`) with the `dest_dir`
 * the scraper would have saved into. This module takes a file the user obtained
 * by hand and files it into that same location, so the scraped corpus is whole.
 *
 * The flow is worklist-driven: the reports the scraper already writes are the
 * list of gaps, keyed by the original Canvas URL. A small manifest (or an
 * interactive prompt) maps a dropped file to one of those gaps.
 */

/**
 * Parses RFC-4180-ish CSV text (the dialect report.js writes: CRLF endings,
 * fields quoted only when they contain a comma/quote/newline, `""` for a
 * literal quote). Returns an array of row objects keyed by the header.
 * @param {string} text
 * @returns {Array<Object>}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    // Ignore a trailing empty line (a final CRLF produces one empty field).
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (field.length || row.length) {
    pushField();
    pushRow();
  }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

/** Escapes a value for CSV (quotes it when it contains a comma, quote, or newline). */
function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * The set of match keys for a URL: its normalized self plus, for a Canvas LTI
 * retrieve link (or a bare HBSP link), the resource token from the target (e.g
 * `H03PQF-PDF-ENG`). Two URLs match when their key sets intersect, so a lightly
 * edited URL (extra query params, trailing slash) still resolves to its gap.
 * @param {string} url
 * @returns {string[]}
 */
export function urlKeys(url) {
  const keys = [];
  const raw = String(url || "").trim();
  if (!raw) return keys;
  keys.push(normalizeUrl(raw));
  const token = hbspToken(raw);
  if (token) keys.push(`hbsp:${token}`);
  return keys;
}

/** Lowercases the origin/path and drops a trailing slash, keeping the query. */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search}`;
  } catch (e) {
    return url.trim().replace(/\/+$/, "");
  }
}

/**
 * Extracts the HBSP resource token (e.g `H03PQF-PDF-ENG`) from a Canvas LTI
 * retrieve URL or a direct HBSP link. Returns "" when there isn't one.
 * @param {string} url
 * @returns {string}
 */
export function hbspToken(url) {
  let target = String(url || "");
  try {
    const u = new URL(url);
    target = u.searchParams.get("url") || url;
  } catch (e) {
    // fall through with the raw string
  }
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch (e) {
    // keep target as-is
  }
  // HBSP element ids look like <ALNUM>-<ALPHA>-<ALPHA>, e.g H03PQF-PDF-ENG.
  const m = decoded.match(/([A-Za-z0-9]+-[A-Za-z]+-[A-Za-z]+)/);
  return m ? m[1].toUpperCase() : "";
}

/**
 * Reads the worklist of download gaps from a scrape's output directory: one
 * entry per skipped/failed asset, keyed by URL, carrying the `destDir` the
 * scraper would have saved into. Reads `report-skipped.csv` and, when present,
 * `download-diagnostics.jsonl` (which can supply a `destDir` the CSV lacks).
 * @param {string} output the scrape output directory
 * @param {string[]} [extraSources] additional worklist files to read
 * @returns {Array<{url,reason,destDir,courseName,courseUrl,source}>}
 */
export function readWorklist(output, extraSources = []) {
  const byUrl = new Map();
  const add = (entry) => {
    if (!entry.url) return;
    const key = normalizeUrl(entry.url);
    const existing = byUrl.get(key);
    if (existing) {
      // Prefer an entry that knows where the file belongs.
      if (!existing.destDir && entry.destDir) existing.destDir = entry.destDir;
      return;
    }
    byUrl.set(key, entry);
  };

  const skippedPath = path.join(output, "report-skipped.csv");
  if (fs.existsSync(skippedPath)) {
    try {
      for (const r of parseCsv(fs.readFileSync(skippedPath, "utf8"))) {
        add({
          url: r.url || "",
          reason: r.reason || "",
          destDir: r.dest_dir || "",
          courseName: r.course_name || "",
          courseUrl: r.course_url || "",
          source: "report-skipped.csv",
        });
      }
    } catch (e) {
      helpers.print("WARNING", "IMPORT", `Could not read ${skippedPath}: ${e.message}`, 0);
    }
  }

  const diagPath = path.join(output, "download-diagnostics.jsonl");
  const jsonlSources = [diagPath, ...extraSources];
  for (const src of jsonlSources) {
    if (!src || !fs.existsSync(src) || !/\.jsonl$/i.test(src)) continue;
    try {
      for (const line of fs.readFileSync(src, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch (e) {
          continue;
        }
        add({
          url: d.url || "",
          reason: d.reason || d.outcome || "",
          destDir: d.destDir || "",
          courseName: d.courseName || "",
          courseUrl: d.courseUrl || "",
          source: path.basename(src),
        });
      }
    } catch (e) {
      helpers.print("WARNING", "IMPORT", `Could not read ${src}: ${e.message}`, 0);
    }
  }

  // CSV-supplied extra sources (e.g a hand-made report-skipped.csv elsewhere).
  for (const src of extraSources) {
    if (!src || !fs.existsSync(src) || !/\.csv$/i.test(src)) continue;
    try {
      for (const r of parseCsv(fs.readFileSync(src, "utf8"))) {
        add({
          url: r.url || "",
          reason: r.reason || "",
          destDir: r.dest_dir || "",
          courseName: r.course_name || "",
          courseUrl: r.course_url || "",
          source: path.basename(src),
        });
      }
    } catch (e) {
      helpers.print("WARNING", "IMPORT", `Could not read ${src}: ${e.message}`, 0);
    }
  }

  return [...byUrl.values()];
}

/**
 * Reads the import manifest — the map from a dropped file to a worklist URL.
 * Accepts CSV (`file,url` columns) or JSON (an array of `{file, url}`). Returns
 * [] when the file doesn't exist.
 * @param {string} manifestPath
 * @returns {Array<{file:string,url:string}>}
 */
export function readManifest(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return [];
  const text = fs.readFileSync(manifestPath, "utf8");
  if (/\.json$/i.test(manifestPath)) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data.entries || [];
    return arr
      .map((e) => ({ file: String(e.file || "").trim(), url: String(e.url || "").trim() }))
      .filter((e) => e.file && e.url);
  }
  return parseCsv(text)
    .map((r) => ({ file: String(r.file || "").trim(), url: String(r.url || "").trim() }))
    .filter((e) => e.file && e.url);
}

/**
 * Reads the append-only import log (the source of truth for what's already been
 * imported, so re-runs are idempotent). Returns [] when it doesn't exist.
 * @param {string} logPath
 * @returns {Array<{time,url,file,dest}>}
 */
export function readImportLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      // ignore a malformed line
    }
  }
  return out;
}

/** Whether `url` has already been imported to a destination that still exists. */
function alreadyImported(url, log) {
  const keys = new Set(urlKeys(url));
  return log.some(
    (e) => urlKeys(e.url).some((k) => keys.has(k)) && e.dest && fs.existsSync(e.dest)
  );
}

/**
 * Resolves manifest entries against the worklist and the drop folder, returning
 * one result per manifest entry with a status the caller can act on:
 *   ready | missing-file | unmatched-url | already-imported
 * @param {Array} worklist from readWorklist
 * @param {Array} manifest from readManifest
 * @param {string} dropDir folder holding the dropped files
 * @param {Array} log from readImportLog
 * @param {string} [output] the output directory (for dest remapping)
 * @param {{kind:string,subdir:string}} [layout] detected output layout
 * @returns {Array<{entry,row,srcFile,dest,status}>}
 */
export function resolve(worklist, manifest, dropDir, log, output = "courses", layout = null) {
  // Index the worklist by every match key.
  const index = new Map();
  for (const row of worklist) {
    for (const k of urlKeys(row.url)) {
      if (!index.has(k)) index.set(k, row);
    }
  }

  return manifest.map((entry) => {
    const srcFile = path.isAbsolute(entry.file)
      ? entry.file
      : path.join(dropDir, entry.file);
    let row = null;
    for (const k of urlKeys(entry.url)) {
      if (index.has(k)) {
        row = index.get(k);
        break;
      }
    }
    let status;
    let dest = "";
    if (!row) {
      status = "unmatched-url";
    } else if (!fs.existsSync(srcFile)) {
      status = "missing-file";
    } else if (alreadyImported(entry.url, log)) {
      status = "already-imported";
    } else {
      status = "ready";
      dest = destForRow(row, output, layout);
    }
    return { entry, row, srcFile, dest, status };
  });
}

/**
 * The folder an imported file for `row` should go into: the recorded `destDir`
 * when the scraper captured one, otherwise a per-course `IMPORTED/` fallback.
 * When the output has been reorganized into a wiki (`raw/`) or Octarine
 * (`.attachments/`) layout, the recorded destDir — captured during scraping,
 * before that reorganization — is remapped under the layout's content subdir so
 * the file lands beside the scraped material, not next to it.
 * @param {object} row a worklist row
 * @param {string} [output] the output directory
 * @param {{kind:string,subdir:string}} [layout] detected output layout
 */
function destForRow(row, output = "courses", layout = null) {
  let dest = row.destDir;
  if (!dest) {
    const course = helpers.stripInvalid(row.courseName || "unknown-course");
    dest = path.join(output, course, "IMPORTED");
  }
  if (layout && layout.subdir) dest = remapUnderSubdir(dest, output, layout.subdir);
  return dest;
}

/**
 * Detects whether `output` is a reorganized workspace and returns its content
 * subdir. A wiki has `raw/` + `CLAUDE.md`; an Octarine workspace has
 * `.attachments/`. Anything else is a plain scrape.
 * @param {string} output
 * @returns {{kind:"wiki"|"octarine"|"plain", subdir:string}}
 */
export function detectLayout(output) {
  if (
    fs.existsSync(path.join(output, "raw")) &&
    fs.existsSync(path.join(output, "CLAUDE.md"))
  ) {
    return { kind: "wiki", subdir: "raw" };
  }
  if (fs.existsSync(path.join(output, ".attachments"))) {
    return { kind: "octarine", subdir: ".attachments" };
  }
  return { kind: "plain", subdir: "" };
}

/**
 * Remaps a scrape-time destination (`<output>/<rest>`) to sit under the layout's
 * content subdir (`<output>/<subdir>/<rest>`). Falls back to an IMPORTED folder
 * inside the subdir when destDir isn't inside `output`.
 */
function remapUnderSubdir(destDir, output, subdir) {
  const rel = path.relative(output, destDir);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return path.join(output, subdir, rel);
  }
  return path.join(output, subdir, "IMPORTED");
}

/** Returns a path that doesn't collide with an existing file (adds " (n)"). */
function uniqueFilePath(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

/**
 * Copies every `ready` resolved entry into place, records provenance, and folds
 * the import into `report.csv` when one exists. Idempotent via the import log.
 * @param {Array} resolved from resolve()
 * @param {object} opts
 * @param {string} opts.output the scrape output directory
 * @param {boolean} [opts.dryRun] when true, plan only — copy/write nothing
 * @returns {{imported:number, skipped:number, unmatched:number, missing:number, planned:Array}}
 */
export function applyImports(resolved, { output, dryRun = false } = {}) {
  const importDir = path.join(output, "import");
  const logPath = path.join(importDir, "imported.log.jsonl");
  const summary = { imported: 0, skipped: 0, unmatched: 0, missing: 0, planned: [] };
  const reportRows = [];

  for (const r of resolved) {
    if (r.status === "already-imported") {
      summary.skipped++;
      continue;
    }
    if (r.status === "unmatched-url") {
      summary.unmatched++;
      helpers.print(
        "WARNING",
        "IMPORT",
        `No matching gap for ${r.entry.file} (url ${r.entry.url}) — skipping.`,
        1
      );
      continue;
    }
    if (r.status === "missing-file") {
      summary.missing++;
      helpers.print("WARNING", "IMPORT", `File not found: ${r.srcFile} — skipping.`, 1);
      continue;
    }

    // status === "ready"
    const filename = helpers.stripInvalid(path.basename(r.srcFile));
    const destPath = uniqueFilePath(r.dest, filename);
    summary.planned.push({ url: r.row.url, src: r.srcFile, dest: destPath });

    if (dryRun) {
      helpers.print("NOTE", "IMPORT", `Would import ${r.srcFile} -> ${destPath}`, 1);
      summary.imported++;
      continue;
    }

    fs.mkdirSync(r.dest, { recursive: true });
    fs.copyFileSync(r.srcFile, destPath);

    // Sidecar records provenance so a scrape/import round-trip can tell an
    // imported asset from a scraped one.
    try {
      fs.writeFileSync(
        `${destPath}.imported.json`,
        JSON.stringify(
          {
            time: new Date().toISOString(),
            url: r.row.url,
            source: path.basename(r.srcFile),
            reason: r.row.reason || "",
            courseName: r.row.courseName || "",
            courseUrl: r.row.courseUrl || "",
          },
          null,
          2
        ) + "\n"
      );
    } catch (e) {
      helpers.print("WARNING", "IMPORT", `Could not write sidecar for ${destPath}: ${e.message}`, 1);
    }

    // Append to the import log (idempotency source of truth).
    try {
      fs.mkdirSync(importDir, { recursive: true });
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          time: new Date().toISOString(),
          url: r.row.url,
          file: path.basename(r.srcFile),
          dest: destPath,
          courseName: r.row.courseName || "",
        }) + "\n"
      );
    } catch (e) {
      helpers.print("WARNING", "IMPORT", `Could not append to import log: ${e.message}`, 1);
    }

    reportRows.push({ filePath: destPath, url: r.row.url, courseName: r.row.courseName, courseUrl: r.row.courseUrl });
    helpers.print("NOTE", "IMPORT", `Imported ${r.srcFile} -> ${destPath}`, 1);
    summary.imported++;
  }

  if (!dryRun && reportRows.length) foldIntoReportCsv(output, reportRows);
  return summary;
}

/**
 * Appends imported files to an existing `report.csv` so downstream tooling sees
 * them as first-class assets. No-op when there's no report.csv (the scrape
 * wasn't run with --report). Rows whose `original_url` is already present are
 * skipped, keeping this idempotent.
 */
function foldIntoReportCsv(output, rows) {
  const reportPath = path.join(output, "report.csv");
  if (!fs.existsSync(reportPath)) return;
  try {
    const existing = parseCsv(fs.readFileSync(reportPath, "utf8"));
    const seen = new Set(existing.map((r) => normalizeUrl(r.original_url || "")));
    const lines = [];
    for (const r of rows) {
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      let sizeBytes = "";
      let sizeHuman = "";
      try {
        sizeBytes = fs.statSync(r.filePath).size;
        sizeHuman = humanSize(sizeBytes);
      } catch (e) {
        // leave size blank if the file vanished
      }
      const ext = path.extname(r.filePath).replace(/^\./, "").toLowerCase() || "unknown";
      lines.push(
        [
          path.basename(r.filePath),
          ext,
          sizeBytes,
          sizeHuman,
          r.courseName || "",
          r.courseUrl || "",
          r.url,
        ]
          .map(csvField)
          .join(",")
      );
    }
    if (lines.length) fs.appendFileSync(reportPath, lines.join("\r\n") + "\r\n");
  } catch (e) {
    helpers.print("WARNING", "IMPORT", `Could not fold imports into report.csv: ${e.message}`, 0);
  }
}

/** Formats a byte count as B/KB/MB/GB (mirrors report.js). */
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

/** A short human label for a gap (its item folder name, or the course). */
function gapLabel(row) {
  if (row.destDir) {
    // …/ASSIGNMENTS/<section>/<item>/ASSIGNMENT -> "<item>"
    const parts = row.destDir.split(/[\\/]/).filter(Boolean);
    const meaningful = parts.filter(
      (p) => !/^ASSIGNMENT$/i.test(p) && !/^(ASSIGNMENTS|MODULES|QUIZZES|VIDEOS)$/i.test(p)
    );
    if (meaningful.length) return meaningful[meaningful.length - 1];
  }
  return row.courseName || row.url;
}

/**
 * Lists the files a user dropped into `dropDir`, excluding the manifest, the
 * import log, and provenance sidecars. Returns basenames.
 */
export function listDroppedFiles(dropDir) {
  if (!fs.existsSync(dropDir)) return [];
  return fs
    .readdirSync(dropDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter(
      (n) =>
        !/^manifest\.(csv|json)$/i.test(n) &&
        !/^imported\.log\.jsonl$/i.test(n) &&
        !/\.imported\.json$/i.test(n)
    );
}

/**
 * Runs the importer. Reads the worklist and manifest, optionally prompts the
 * user to match unmapped dropped files (via `hooks.prompt`), then applies the
 * imports.
 * @param {string} output the scrape output directory
 * @param {object} [options]
 * @param {string} [options.from] extra worklist source (csv or jsonl)
 * @param {string} [options.manifest] manifest path (default <output>/import/manifest.csv)
 * @param {string} [options.dir] drop folder (default <output>/import)
 * @param {boolean} [options.interactive] prompt to match unmapped files
 * @param {boolean} [options.dryRun] plan only
 * @param {object} [hooks]
 * @param {function} [hooks.prompt] async (worklist, files, log) => extra manifest entries
 * @returns {Promise<object>} the apply summary
 */
export async function runImport(output, options = {}, hooks = {}) {
  const dropDir = options.dir || path.join(output, "import");
  const manifestPath = options.manifest || path.join(dropDir, "manifest.csv");
  const logPath = path.join(output, "import", "imported.log.jsonl");

  const worklist = readWorklist(output, options.from ? [options.from] : []);
  const log = readImportLog(logPath);

  if (!worklist.length) {
    helpers.print(
      "NOTE",
      "IMPORT",
      `No download gaps found in ${output} (looked for report-skipped.csv / download-diagnostics.jsonl).`,
      0
    );
    return { imported: 0, skipped: 0, unmatched: 0, missing: 0, planned: [] };
  }

  let manifest = readManifest(manifestPath);

  if (options.interactive && typeof hooks.prompt === "function") {
    const files = listDroppedFiles(dropDir);
    const mapped = new Set(manifest.map((m) => m.file));
    const unmapped = files.filter((f) => !mapped.has(f));
    if (unmapped.length) {
      const extra = await hooks.prompt(worklist, unmapped, log, { gapLabel });
      manifest = manifest.concat(extra || []);
    }
  }

  if (!manifest.length) {
    helpers.print(
      "WARNING",
      "IMPORT",
      `${worklist.length} gap(s) to fill, but no manifest at ${manifestPath}. ` +
        `Create it (file,url columns) or re-run with --interactive.`,
      0
    );
    // Surface the worklist so the user knows what to obtain.
    for (const row of worklist) {
      helpers.print("NOTE", "IMPORT", `  ${gapLabel(row)} — ${row.url}`, 0);
    }
    return { imported: 0, skipped: 0, unmatched: 0, missing: 0, planned: [] };
  }

  // If the output was reorganized into a wiki / Octarine workspace, imports go
  // under raw/ (or .attachments/) — the recorded destDir is remapped for that.
  const layout = detectLayout(output);
  const resolved = resolve(worklist, manifest, dropDir, log, output, layout);
  const summary = applyImports(resolved, { output, dryRun: options.dryRun });

  // Fold imports into the wiki/Octarine catalog so they're listed alongside the
  // scraped material (best-effort; a failure here doesn't fail the import).
  if (!options.dryRun && summary.imported > 0 && layout.kind !== "plain") {
    reconcileLayout(output, layout, summary);
  }

  helpers.print(
    "NOTE",
    "IMPORT",
    `${options.dryRun ? "[dry-run] " : ""}Imported ${summary.imported}, ` +
      `already-present ${summary.skipped}, unmatched ${summary.unmatched}, missing ${summary.missing}.`,
    0
  );
  return summary;
}

/**
 * Reconstructs report rows from `report.csv` so a layout re-index can restore
 * source links for every catalogued file (scraped and imported alike). Returns
 * [] when there's no report.csv.
 */
function readReportRows(output) {
  const reportPath = path.join(output, "report.csv");
  if (!fs.existsSync(reportPath)) return [];
  try {
    return parseCsv(fs.readFileSync(reportPath, "utf8")).map((r) => ({
      file: r.file || "",
      originalUrl: r.original_url || "",
      courseName: r.course_name || "",
      courseUrl: r.course_url || "",
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Regenerates the wiki index.md (or Octarine notes + Index.md) so freshly
 * imported files appear in the catalog. Uses reindex() — not build() — so it
 * rescans raw/ (or .attachments/) in place without sweeping unrelated top-level
 * artifacts. Best-effort: logs and swallows its own failure.
 */
function reconcileLayout(output, layout, summary) {
  const rows = readReportRows(output);
  try {
    if (layout.kind === "wiki") {
      wiki.reindex(output, rows, `imported ${summary.imported} file(s) via manual import`);
      helpers.print("NOTE", "IMPORT", `Regenerated ${path.join(output, "index.md")} to include imports.`, 0);
    } else if (layout.kind === "octarine") {
      octarine.reindex(output, rows);
      helpers.print("NOTE", "IMPORT", `Regenerated ${path.join(output, "Index.md")} to include imports.`, 0);
    }
  } catch (e) {
    helpers.print("WARNING", "IMPORT", `Could not regenerate ${layout.kind} catalog: ${e.message}`, 0);
  }
}

// Exported for testing.
export { destForRow, gapLabel, normalizeUrl };
