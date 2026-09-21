import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import helpers from "../scrapers/helpers.js";
import manifest, { normalizeUrl } from "../scrapers/manifest.js";

// Keep test output quiet.
helpers.setPrinter(() => {});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mkuniquedir-test-"));
}

// Simulate the start of a course scrape: load a manifest and reset the
// per-course folder-reuse tracking.
function startCourse(courseDir, courseUrl = "https://x.edu/courses/1") {
  manifest.reset();
  manifest.setForce(false);
  helpers.setDryRun(false);
  manifest.load(courseDir, courseUrl);
  helpers.resetCreatedDirs();
}

test("two distinct items with the same name get (2) within one run", () => {
  const dir = tmpDir();
  startCourse(dir);
  const a = helpers.mkUniqueDir(path.join(dir, "MODULES", "Intro"));
  const b = helpers.mkUniqueDir(path.join(dir, "MODULES", "Intro"));
  assert.equal(a, path.join(dir, "MODULES", "Intro"));
  assert.equal(b, path.join(dir, "MODULES", "Intro (2)"));
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test("a folder from a previous run is reused, not duplicated", () => {
  const dir = tmpDir();

  // Run 1: creates MODULES/Intro.
  startCourse(dir);
  const first = helpers.mkUniqueDir(path.join(dir, "MODULES", "Intro"));
  fs.writeFileSync(path.join(first, "keep.txt"), "x");

  // Run 2 (fresh reuse tracking, folder still on disk): same name reused.
  startCourse(dir);
  const second = helpers.mkUniqueDir(path.join(dir, "MODULES", "Intro"));
  assert.equal(second, first, "reused the existing folder — no (2) sibling");
  assert.equal(fs.existsSync(path.join(dir, "MODULES", "Intro (2)")), false);
  assert.equal(fs.readFileSync(path.join(second, "keep.txt"), "utf8"), "x");
});

test("identity reuse renames a folder whose display name changed, keeping its files", () => {
  const dir = tmpDir();
  const assignmentUrl = "https://x.edu/courses/1/assignments/500";

  // Run 1: assignment folder embeds an ungraded suffix, with a downloaded file.
  startCourse(dir);
  const run1 = helpers.mkUniqueDir(
    path.join(dir, "ASSIGNMENTS", "HW", "Essay (NA)"),
    assignmentUrl
  );
  const filePath = path.join(run1, "reading.pdf");
  fs.writeFileSync(filePath, "pdf-bytes");
  // Record the file in the manifest (as a download would).
  manifest.record("https://x.edu/files/9/download", filePath, { bytes: 9 });
  manifest.save();

  // Run 2: the grade posted, so the desired folder name changed.
  startCourse(dir);
  const run2 = helpers.mkUniqueDir(
    path.join(dir, "ASSIGNMENTS", "HW", "Essay (A-)"),
    assignmentUrl
  );

  assert.equal(run2, path.join(dir, "ASSIGNMENTS", "HW", "Essay (A-)"));
  assert.equal(fs.existsSync(run1), false, "old-grade folder was renamed away");
  assert.equal(
    fs.readFileSync(path.join(run2, "reading.pdf"), "utf8"),
    "pdf-bytes",
    "the downloaded file moved with the folder"
  );

  // The manifest asset path followed the rename, so the file still resolves as
  // complete (a resumed download would skip it, not re-fetch).
  const entry = manifest.assets[normalizeUrl("https://x.edu/files/9/download")];
  assert.equal(entry.path, path.join("ASSIGNMENTS", "HW", "Essay (A-)", "reading.pdf"));
  assert.equal(
    manifest.completePath("https://x.edu/files/9/download"),
    path.join(run2, "reading.pdf")
  );
});

test("identity reuse returns the same folder when the name is unchanged", () => {
  const dir = tmpDir();
  const url = "https://x.edu/courses/1/assignments/501";

  startCourse(dir);
  const run1 = helpers.mkUniqueDir(path.join(dir, "ASSIGNMENTS", "HW", "Lab (B)"), url);
  manifest.save();

  startCourse(dir);
  const run2 = helpers.mkUniqueDir(path.join(dir, "ASSIGNMENTS", "HW", "Lab (B)"), url);
  assert.equal(run2, run1);
  assert.equal(fs.existsSync(path.join(dir, "ASSIGNMENTS", "HW", "Lab (B) (2)")), false);
});

test("dry-run returns the desired path and creates nothing", () => {
  const dir = tmpDir();
  startCourse(dir);
  helpers.setDryRun(true);
  const p = helpers.mkUniqueDir(path.join(dir, "MODULES", "Ghost"));
  helpers.setDryRun(false);
  assert.equal(p, path.join(dir, "MODULES", "Ghost"));
  assert.equal(fs.existsSync(p), false);
});
