import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import wiki from "../scrapers/wiki.js";
import octarine from "../scrapers/octarine.js";

function scrapeOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-meta-test-"));
  const course = path.join(dir, "MyCourse");
  fs.mkdirSync(path.join(course, "ASSIGNMENTS", "HW"), { recursive: true });
  fs.writeFileSync(path.join(course, "ASSIGNMENTS", "HW", "reading.pdf"), "pdf");
  // Resume bookkeeping that must never be treated as course material.
  fs.writeFileSync(path.join(course, ".scrape-manifest.json"), '{"version":1}');
  fs.writeFileSync(path.join(course, ".yt-dlp-archive.txt"), "youtube abc123");
  // An interrupted download left a .part file behind.
  fs.writeFileSync(path.join(course, "ASSIGNMENTS", "HW", "big.pdf.part"), "half");
  return dir;
}

test("wiki does not catalog the resume manifest, yt-dlp archive, or .part files", () => {
  const dir = scrapeOutput();
  const { sources } = wiki.build(dir);

  assert.equal(sources, 1, "only reading.pdf is a source");
  const index = fs.readFileSync(path.join(dir, "index.md"), "utf8");
  assert.ok(!index.includes(".scrape-manifest"), "manifest not in index");
  assert.ok(!index.includes(".yt-dlp-archive"), "archive not in index");
  assert.ok(!index.includes(".part"), ".part not in index");
  assert.ok(index.includes("reading.pdf"), "real source is in index");

  // The dotfiles still travel with the course folder into raw/ (they aren't
  // course material, but the sweep moves the whole folder), so resume metadata
  // isn't destroyed — just not cataloged.
  assert.ok(fs.existsSync(path.join(dir, "raw", "MyCourse", ".scrape-manifest.json")));
});

test("octarine does not catalog the resume manifest, yt-dlp archive, or .part files", () => {
  const dir = scrapeOutput();
  const { sources } = octarine.build(dir, [{ courseName: "MyCourse" }]);

  assert.equal(sources, 1, "only reading.pdf is a source");
  const files = fs.readdirSync(dir);
  const indexName = files.find((f) => f.toLowerCase() === "index.md");
  const index = fs.readFileSync(path.join(dir, indexName), "utf8");
  assert.ok(!index.includes(".scrape-manifest"));
  assert.ok(!index.includes(".yt-dlp-archive"));
});
