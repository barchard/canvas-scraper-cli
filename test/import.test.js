import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import helpers from "../scrapers/helpers.js";
import wiki from "../scrapers/wiki.js";
import octarine from "../scrapers/octarine.js";
import {
  parseCsv,
  hbspToken,
  urlKeys,
  readWorklist,
  readManifest,
  resolve,
  applyImports,
  runImport,
  gapLabel,
  detectLayout,
} from "../core/import.js";

// Keep test output quiet.
helpers.setPrinter(() => {});

const HBSP_URL =
  "https://canvas.mit.edu/courses/38458/external_tools/retrieve?url=https%3A%2F%2Fservices.hbsp.harvard.edu%2Flti%2Flinks%2FH03PQF-PDF-ENG%2Frich-text";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "importer-test-"));
}

test("parseCsv handles quoted fields, commas, and CRLF", () => {
  const csv = 'url,reason,dest_dir\r\n"a,b","x ""y""",courses/C/ASSIGNMENTS/S/I\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "a,b");
  assert.equal(rows[0].reason, 'x "y"');
  assert.equal(rows[0].dest_dir, "courses/C/ASSIGNMENTS/S/I");
});

test("hbspToken extracts the resource id from a retrieve URL", () => {
  assert.equal(hbspToken(HBSP_URL), "H03PQF-PDF-ENG");
  assert.equal(
    hbspToken("https://services.hbsp.harvard.edu/lti/links/R1105C-PDF-ENG/rich-text"),
    "R1105C-PDF-ENG"
  );
  assert.equal(hbspToken("https://example.com/plain"), "");
});

test("urlKeys of a retrieve URL and its bare HBSP target intersect", () => {
  const a = new Set(urlKeys(HBSP_URL));
  const b = urlKeys(
    "https://services.hbsp.harvard.edu/lti/links/H03PQF-PDF-ENG/rich-text"
  );
  assert.ok(b.some((k) => a.has(k)), "shared hbsp token should match");
});

test("readWorklist reads report-skipped.csv with dest_dir and dedupes by URL", () => {
  const dir = tmpDir();
  const dest = "courses/C/ASSIGNMENTS/Past/Item/ASSIGNMENT";
  fs.writeFileSync(
    path.join(dir, "report-skipped.csv"),
    `url,reason,dest_dir,course_name,course_url\r\n` +
      `${HBSP_URL},HBSP content not accessible,${dest},15.716,https://canvas.mit.edu/courses/38458\r\n` +
      `${HBSP_URL},HBSP content not accessible,,15.716,https://canvas.mit.edu/courses/38458\r\n`
  );
  const wl = readWorklist(dir);
  assert.equal(wl.length, 1, "same URL collapses to one gap");
  assert.equal(wl[0].destDir, dest);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readWorklist backfills dest_dir from download-diagnostics.jsonl", () => {
  const dir = tmpDir();
  const dest = "/abs/courses/C/MODULES/Wk1/Item";
  // CSV row lacks a dest_dir; the diagnostics line supplies one.
  fs.writeFileSync(
    path.join(dir, "report-skipped.csv"),
    `url,reason,dest_dir,course_name,course_url\r\n${HBSP_URL},reason,,15.716,url\r\n`
  );
  fs.writeFileSync(
    path.join(dir, "download-diagnostics.jsonl"),
    JSON.stringify({ url: HBSP_URL, destDir: dest, outcome: "no-pdf-form" }) + "\n"
  );
  const wl = readWorklist(dir);
  assert.equal(wl.length, 1);
  assert.equal(wl[0].destDir, dest);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readManifest parses CSV and JSON", () => {
  const dir = tmpDir();
  const csvPath = path.join(dir, "m.csv");
  fs.writeFileSync(csvPath, `file,url\nA.pdf,${HBSP_URL}\n`);
  assert.deepEqual(readManifest(csvPath), [{ file: "A.pdf", url: HBSP_URL }]);

  const jsonPath = path.join(dir, "m.json");
  fs.writeFileSync(jsonPath, JSON.stringify([{ file: "B.pdf", url: HBSP_URL }]));
  assert.deepEqual(readManifest(jsonPath), [{ file: "B.pdf", url: HBSP_URL }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gapLabel returns the item folder name", () => {
  assert.equal(
    gapLabel({ destDir: "courses/C/ASSIGNMENTS/Past Assignments/Session 5/ASSIGNMENT" }),
    "Session 5"
  );
  assert.equal(gapLabel({ courseName: "15.716", url: "x" }), "15.716");
});

test("resolve classifies ready / missing-file / unmatched-url", () => {
  const dir = tmpDir();
  const dropDir = path.join(dir, "import");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "present.pdf"), "%PDF-1.4 present");

  const worklist = [
    { url: HBSP_URL, reason: "r", destDir: path.join(dir, "dest"), courseName: "C", courseUrl: "u" },
  ];
  const manifest = [
    { file: "present.pdf", url: HBSP_URL },
    { file: "missing.pdf", url: HBSP_URL },
    { file: "present.pdf", url: "https://unknown.example/x" },
  ];
  const resolved = resolve(worklist, manifest, dropDir, []);
  assert.equal(resolved[0].status, "ready");
  assert.equal(resolved[1].status, "missing-file");
  assert.equal(resolved[2].status, "unmatched-url");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("applyImports copies the file, writes provenance, and is idempotent", () => {
  const dir = tmpDir();
  const output = dir;
  const dropDir = path.join(output, "import");
  const destDir = path.join(output, "courses", "C", "ASSIGNMENTS", "Past", "Item");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "case.pdf"), "%PDF-1.4 body");

  const worklist = [
    { url: HBSP_URL, reason: "not accessible", destDir, courseName: "C", courseUrl: "u" },
  ];
  const manifest = [{ file: "case.pdf", url: HBSP_URL }];

  const first = applyImports(resolve(worklist, manifest, dropDir, []), { output });
  assert.equal(first.imported, 1);
  const placed = path.join(destDir, "case.pdf");
  assert.ok(fs.existsSync(placed), "file copied into dest_dir");
  assert.ok(fs.existsSync(`${placed}.imported.json`), "sidecar written");
  const logPath = path.join(output, "import", "imported.log.jsonl");
  assert.ok(fs.existsSync(logPath), "import log written");
  assert.equal(fs.readFileSync(logPath, "utf8").trim().split("\n").length, 1);

  // Re-run: already-imported, nothing copied again.
  const log = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const second = applyImports(resolve(worklist, manifest, dropDir, log), { output });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1, "second run recognizes already-imported");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("applyImports folds into an existing report.csv without duplicating", () => {
  const dir = tmpDir();
  const output = dir;
  const dropDir = path.join(output, "import");
  const destDir = path.join(output, "courses", "C", "MODULES", "Wk1");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "reading.pdf"), "%PDF-1.4 reading bytes");
  fs.writeFileSync(
    path.join(output, "report.csv"),
    "file,type,size_bytes,size,course_name,course_url,original_url\r\n"
  );

  const worklist = [{ url: HBSP_URL, reason: "r", destDir, courseName: "C", courseUrl: "u" }];
  const manifest = [{ file: "reading.pdf", url: HBSP_URL }];
  applyImports(resolve(worklist, manifest, dropDir, []), { output });

  const rows = parseCsv(fs.readFileSync(path.join(output, "report.csv"), "utf8"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, "reading.pdf");
  assert.equal(rows[0].original_url, HBSP_URL);
  assert.equal(rows[0].type, "pdf");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dry-run plans but writes nothing", () => {
  const dir = tmpDir();
  const output = dir;
  const dropDir = path.join(output, "import");
  const destDir = path.join(output, "courses", "C", "ASSIGNMENTS", "S", "I");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "x.pdf"), "bytes");
  const worklist = [{ url: HBSP_URL, reason: "r", destDir, courseName: "C", courseUrl: "u" }];
  const manifest = [{ file: "x.pdf", url: HBSP_URL }];
  const summary = applyImports(resolve(worklist, manifest, dropDir, []), {
    output,
    dryRun: true,
  });
  assert.equal(summary.imported, 1);
  assert.equal(summary.planned.length, 1);
  assert.ok(!fs.existsSync(path.join(destDir, "x.pdf")), "nothing copied on dry-run");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("detectLayout recognizes wiki, octarine, and plain outputs", () => {
  const dir = tmpDir();
  assert.equal(detectLayout(dir).kind, "plain");
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "schema");
  assert.deepEqual(detectLayout(dir), { kind: "wiki", subdir: "raw" });
  const dir2 = tmpDir();
  fs.mkdirSync(path.join(dir2, ".attachments"), { recursive: true });
  assert.deepEqual(detectLayout(dir2), { kind: "octarine", subdir: ".attachments" });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("import into a wiki workspace remaps under raw/ and regenerates index.md", async () => {
  const output = tmpDir();
  const scraped = path.join(output, "15.716", "ASSIGNMENTS", "Past", "Item", "ASSIGNMENT");
  fs.mkdirSync(scraped, { recursive: true });
  fs.writeFileSync(path.join(scraped, "existing.pdf"), "%PDF-1.4 existing");
  fs.writeFileSync(
    path.join(output, "report.csv"),
    "file,type,size_bytes,size,course_name,course_url,original_url\r\n" +
      "existing.pdf,pdf,17,17 B,15.716,https://c/38458,https://c/orig\r\n"
  );
  fs.writeFileSync(
    path.join(output, "report-skipped.csv"),
    `url,reason,dest_dir,course_name,course_url\r\n${HBSP_URL},not accessible,${scraped},15.716,https://c/38458\r\n`
  );
  // Organize into the wiki layout (moves 15.716 into raw/).
  wiki.build(output, [
    { file: "existing.pdf", originalUrl: "https://c/orig", courseName: "15.716", courseUrl: "https://c/38458" },
  ]);
  assert.equal(detectLayout(output).kind, "wiki");

  // Drop a hand-obtained file and import it.
  const dropDir = path.join(output, "import");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "session5.pdf"), "%PDF-1.4 s5");
  fs.writeFileSync(path.join(dropDir, "manifest.csv"), `file,url\nsession5.pdf,${HBSP_URL}\n`);

  const summary = await runImport(output, {});
  assert.equal(summary.imported, 1);

  const placed = path.join(output, "raw", "15.716", "ASSIGNMENTS", "Past", "Item", "ASSIGNMENT", "session5.pdf");
  assert.ok(fs.existsSync(placed), "imported file lands under raw/ beside scraped material");

  const index = fs.readFileSync(path.join(output, "index.md"), "utf8");
  assert.match(index, /session5\.pdf\)/, "index lists the import");
  assert.match(index, /existing\.pdf/, "index still lists scraped material");
  assert.doesNotMatch(index, /imported\.json/, "provenance sidecar is not catalogued as a source");
  const log = fs.readFileSync(path.join(output, "log.md"), "utf8");
  assert.match(log, /manual import/, "log records the import");
  fs.rmSync(output, { recursive: true, force: true });
});

test("import into an Octarine workspace remaps under .attachments/ and regenerates Index.md", async () => {
  const output = tmpDir();
  const scraped = path.join(output, "15.716", "MODULES", "Wk1", "Item");
  fs.mkdirSync(scraped, { recursive: true });
  fs.writeFileSync(path.join(scraped, "existing.pdf"), "%PDF-1.4 existing");
  fs.writeFileSync(
    path.join(output, "report-skipped.csv"),
    `url,reason,dest_dir,course_name,course_url\r\n${HBSP_URL},not accessible,${scraped},15.716,https://c/38458\r\n`
  );
  octarine.build(output, [
    { courseName: "15.716", courseUrl: "https://c/38458" },
  ]);
  assert.equal(detectLayout(output).kind, "octarine");

  const dropDir = path.join(output, "import");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "reading.pdf"), "%PDF-1.4 reading");
  fs.writeFileSync(path.join(dropDir, "manifest.csv"), `file,url\nreading.pdf,${HBSP_URL}\n`);

  const summary = await runImport(output, {});
  assert.equal(summary.imported, 1);

  const placed = path.join(output, ".attachments", "15.716", "MODULES", "Wk1", "Item", "reading.pdf");
  assert.ok(fs.existsSync(placed), "imported file lands under .attachments/");
  const note = fs.readFileSync(path.join(output, "Courses", "15.716.md"), "utf8");
  assert.match(note, /reading\.pdf/, "course note links the import");
  fs.rmSync(output, { recursive: true, force: true });
});

test("import leaves top-level artifacts in place (no wrongful sweep on reindex)", async () => {
  const output = tmpDir();
  const scraped = path.join(output, "15.716", "ASSIGNMENTS", "S", "I", "ASSIGNMENT");
  fs.mkdirSync(scraped, { recursive: true });
  fs.writeFileSync(path.join(scraped, "existing.pdf"), "bytes");
  fs.writeFileSync(
    path.join(output, "report-skipped.csv"),
    `url,reason,dest_dir,course_name,course_url\r\n${HBSP_URL},r,${scraped},15.716,u\r\n`
  );
  wiki.build(output, []);
  // Artifacts the sweep does NOT reserve, written after build in a real run.
  fs.writeFileSync(path.join(output, "download-diagnostics.jsonl"), "{}\n");
  fs.writeFileSync(path.join(output, "errors.csv"), "time\n");

  const dropDir = path.join(output, "import");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "x.pdf"), "x");
  fs.writeFileSync(path.join(dropDir, "manifest.csv"), `file,url\nx.pdf,${HBSP_URL}\n`);
  await runImport(output, {});

  // These must still be at top level (not swept into raw/) after reindex.
  assert.ok(fs.existsSync(path.join(output, "download-diagnostics.jsonl")));
  assert.ok(fs.existsSync(path.join(output, "errors.csv")));
  assert.ok(!fs.existsSync(path.join(output, "raw", "download-diagnostics.jsonl")));
  fs.rmSync(output, { recursive: true, force: true });
});

test("runImport end-to-end via manifest", async () => {
  const dir = tmpDir();
  const output = dir;
  const dropDir = path.join(output, "import");
  const destDir = path.join(output, "courses", "C", "ASSIGNMENTS", "Past", "Session 5");
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(dropDir, "session5.pdf"), "%PDF-1.4 s5");
  fs.writeFileSync(
    path.join(output, "report-skipped.csv"),
    `url,reason,dest_dir,course_name,course_url\r\n${HBSP_URL},not accessible,${destDir},15.716,u\r\n`
  );
  fs.writeFileSync(path.join(dropDir, "manifest.csv"), `file,url\nsession5.pdf,${HBSP_URL}\n`);

  const summary = await runImport(output, {});
  assert.equal(summary.imported, 1);
  assert.ok(fs.existsSync(path.join(destDir, "session5.pdf")));
  fs.rmSync(dir, { recursive: true, force: true });
});
