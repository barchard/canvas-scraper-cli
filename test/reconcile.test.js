import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import manifest, { normalizeUrl } from "../scrapers/manifest.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
}

// Records a completed asset with a back-dated last_seen so it looks like it was
// downloaded in a PREVIOUS run (before the current run's start).
function recordOld(courseDir, url, relPath, bytes = 3) {
  const abs = path.join(courseDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x".repeat(bytes));
  manifest.record(url, abs, { bytes });
  manifest.assets[normalizeUrl(url)].last_seen = "2000-01-01T00:00:00.000Z";
  return abs;
}

test("an asset still referenced this run is kept and not flagged", () => {
  const dir = tmpDir();
  manifest.reset();
  manifest.setPrune(false);
  manifest.load(dir, "https://x.edu/courses/1");
  const url = "https://x.edu/files/1/download";
  recordOld(dir, url, path.join("ASSIGNMENTS", "HW", "a.pdf"));

  manifest.markSeen(url); // referenced this run
  const { removed, pruned } = manifest.reconcile(new Set(["ASSIGNMENTS"]));
  assert.equal(removed, 0);
  assert.equal(pruned, 0);
  assert.equal(manifest.assets[normalizeUrl(url)].state, "downloaded");
});

test("an asset not referenced this run is flagged removed but kept on disk", () => {
  const dir = tmpDir();
  manifest.reset();
  manifest.setPrune(false);
  manifest.load(dir, "https://x.edu/courses/1");
  const url = "https://x.edu/files/2/download";
  const abs = recordOld(dir, url, path.join("ASSIGNMENTS", "HW", "gone.pdf"));

  // Not marked seen -> its source is gone from the course.
  const { removed, pruned } = manifest.reconcile(new Set(["ASSIGNMENTS"]));
  assert.equal(removed, 1);
  assert.equal(pruned, 0);
  assert.equal(manifest.assets[normalizeUrl(url)].state, "removed");
  assert.equal(fs.existsSync(abs), true, "file kept by default");
});

test("--prune deletes the file and drops the entry", () => {
  const dir = tmpDir();
  manifest.reset();
  manifest.setPrune(true);
  manifest.load(dir, "https://x.edu/courses/1");
  const url = "https://x.edu/files/3/download";
  const abs = recordOld(dir, url, path.join("MODULES", "U1", "old.pdf"));

  const { removed, pruned } = manifest.reconcile(new Set(["MODULES"]));
  assert.equal(pruned, 1);
  assert.equal(removed, 0);
  assert.equal(fs.existsSync(abs), false, "file deleted under --prune");
  assert.equal(manifest.assets[normalizeUrl(url)], undefined, "entry dropped");
  manifest.setPrune(false);
});

test("a category not scraped this run is never touched (partial run safety)", () => {
  const dir = tmpDir();
  manifest.reset();
  manifest.setPrune(true); // even with prune on...
  manifest.load(dir, "https://x.edu/courses/1");
  const url = "https://x.edu/files/4/download";
  const abs = recordOld(dir, url, path.join("MODULES", "U1", "keep.pdf"));

  // Only ASSIGNMENTS was scraped, so the MODULES asset must be left alone.
  const { removed, pruned } = manifest.reconcile(new Set(["ASSIGNMENTS"]));
  assert.equal(removed, 0);
  assert.equal(pruned, 0);
  assert.equal(fs.existsSync(abs), true, "other category's file untouched");
  manifest.setPrune(false);
});

test("a downloaded-then-locked item keeps its file: markSeen refreshes last_seen", () => {
  const dir = tmpDir();
  manifest.reset();
  manifest.setPrune(true);
  manifest.load(dir, "https://x.edu/courses/1");
  const url = "https://x.edu/files/5/download";
  const abs = recordOld(dir, url, path.join("ASSIGNMENTS", "HW", "locked.pdf"));

  // The item is still listed but now locked; the scraper references it (a skip,
  // since the file is already on disk), which marks it seen this run.
  manifest.markSeen(url);
  const { removed, pruned } = manifest.reconcile(new Set(["ASSIGNMENTS"]));
  assert.equal(removed, 0);
  assert.equal(pruned, 0);
  assert.equal(fs.existsSync(abs), true, "locked item's file is kept, not pruned");
  manifest.setPrune(false);
});
