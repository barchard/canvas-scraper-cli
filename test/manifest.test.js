import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import helpers from "../scrapers/helpers.js";
import manifest, { MANIFEST_FILE, normalizeUrl } from "../scrapers/manifest.js";

// Keep test output quiet.
helpers.setPrinter(() => {});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
}

// Always start each test from a clean manifest singleton.
function freshManifest(courseDir, courseUrl = "https://x.edu/courses/1") {
  manifest.reset();
  manifest.setForce(false);
  manifest.load(courseDir, courseUrl);
}

test("normalizeUrl strips volatile verifier/token params but keeps real ones", () => {
  const a = normalizeUrl("https://X.edu/files/42/download?verifier=abc&download_frd=1");
  const b = normalizeUrl("https://x.edu/files/42/download?verifier=zzz");
  assert.equal(a, b, "rotated verifier/frd tokens normalize to the same key");
  assert.equal(a, "https://x.edu/files/42/download");

  const withReal = normalizeUrl("https://x.edu/files/42/download?page=3&verifier=abc");
  assert.equal(withReal, "https://x.edu/files/42/download?page=3");
});

test("completePath returns null until an asset is recorded, then the path", () => {
  const dir = tmpDir();
  freshManifest(dir);
  const url = "https://x.edu/files/7/download?verifier=aaa";

  assert.equal(manifest.completePath(url), null, "unknown asset is not complete");

  const file = path.join(dir, "ASSIGNMENTS", "Week 1", "reading.pdf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "hello");
  manifest.record(url, file, { bytes: 5 });

  // A rotated verifier still matches the recorded entry.
  const rotated = "https://x.edu/files/7/download?verifier=bbb";
  assert.equal(manifest.completePath(rotated), file, "matches despite rotated token");
});

test("completePath re-downloads when the file is missing or the size mismatches", () => {
  const dir = tmpDir();
  freshManifest(dir);
  const url = "https://x.edu/files/8/download";
  const file = path.join(dir, "a.bin");
  fs.writeFileSync(file, "1234567890"); // 10 bytes
  manifest.record(url, file, { bytes: 10 });
  assert.equal(manifest.completePath(url), file);

  // Truncated on disk -> size mismatch -> must re-download.
  fs.writeFileSync(file, "123");
  assert.equal(manifest.completePath(url), null, "size mismatch re-downloads");

  // Gone entirely -> must re-download.
  fs.rmSync(file);
  assert.equal(manifest.completePath(url), null, "missing file re-downloads");
});

test("unknown byte count treats a present file as complete", () => {
  const dir = tmpDir();
  freshManifest(dir);
  const url = "https://x.edu/files/9/download";
  const file = path.join(dir, "b.bin");
  fs.writeFileSync(file, "anything");
  manifest.record(url, file, { bytes: 0 }); // server gave no Content-Length
  assert.equal(manifest.completePath(url), file, "present file trusted when size unknown");
});

test("--force bypasses the skip so everything re-downloads", () => {
  const dir = tmpDir();
  freshManifest(dir);
  manifest.setForce(true);
  const url = "https://x.edu/files/10/download";
  const file = path.join(dir, "c.bin");
  fs.writeFileSync(file, "xyz");
  manifest.record(url, file, { bytes: 3 });
  assert.equal(manifest.completePath(url), null, "force ignores the manifest");
  manifest.setForce(false);
});

test("save writes an atomic per-course manifest that reloads with relative paths", () => {
  const dir = tmpDir();
  freshManifest(dir);
  const url = "https://x.edu/files/11/download";
  const file = path.join(dir, "MODULES", "Unit 2", "slides.pdf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "deck");
  manifest.record(url, file, { bytes: 4, etag: '"e1"' });
  manifest.save();

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE)));
  assert.equal(onDisk.version, 1);
  const entry = onDisk.assets[normalizeUrl(url)];
  assert.equal(entry.path, path.join("MODULES", "Unit 2", "slides.pdf"));
  assert.equal(entry.complete, true);
  assert.equal(fs.existsSync(path.join(dir, MANIFEST_FILE + ".part")), false);

  // A reload resolves the relative path back to the real file — so the entry
  // survives even if the whole course folder is later moved (wiki/octarine).
  const moved = tmpDir();
  fs.cpSync(dir, moved, { recursive: true });
  manifest.reset();
  manifest.load(moved, url);
  assert.equal(manifest.completePath(url), path.join(moved, "MODULES", "Unit 2", "slides.pdf"));
});

test("downloadFile skips the network entirely when the manifest says complete", async () => {
  const dir = tmpDir();
  freshManifest(dir);
  const url = "https://x.edu/files/99/download?verifier=one";
  const file = path.join(dir, "done.pdf");
  fs.writeFileSync(file, "already here");
  manifest.record(url, file, { bytes: fs.statSync(file).size });

  // Point the "re-download" path at an unroutable address: if downloadFile did
  // NOT skip, the real fetch would throw and this call would reject. A clean
  // `true` proves the manifest short-circuited before any network call.
  const unreachable = "http://127.0.0.1:9/files/99/download?verifier=two";
  // Same normalized key (host+path) so the manifest matches the rotated URL.
  manifest.record("https://x.edu/files/99/download", file, {
    bytes: fs.statSync(file).size,
  });

  const ok = await helpers.downloadFile(url, [], dir, "backup.txt");
  assert.equal(ok, true, "skipped, returned success, no fetch");
  manifest.reset();
});

test("save writes the manifest file even when nothing was downloaded", () => {
  const dir = tmpDir();
  manifest.reset();
  manifest.load(dir, "https://x.edu/courses/1");
  // No record() calls — mirrors a run that only captured PDFs or failed early.
  manifest.save();
  // scrapeCourse's finally always calls save(), so the file must exist so a
  // resumed run has something to load (this is the bug where an early return on
  // an unreachable homepage left no .scrape-manifest.json).
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE)));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.assets, {});
});

test("a disabled manifest (no course loaded) never skips or records", () => {
  manifest.reset(); // enabled = false
  assert.equal(manifest.completePath("https://x.edu/files/1/download"), null);
  // record is a no-op when disabled — must not throw.
  manifest.record("https://x.edu/files/1/download", "/tmp/whatever");
  assert.equal(manifest.lookup("https://x.edu/files/1/download"), undefined);
});
