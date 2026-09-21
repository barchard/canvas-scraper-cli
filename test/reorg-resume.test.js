import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import wiki from "../scrapers/wiki.js";
import octarine from "../scrapers/octarine.js";
import { reorganizedCourseDir } from "../core/scrape.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reorg-resume-test-"));
}

function writeCourse(dir, relFiles) {
  for (const [rel, content] of Object.entries(relFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

test("reorganizedCourseDir finds a course relocated by --wiki, then --octarine, else null", () => {
  const dir = tmpDir();
  assert.equal(reorganizedCourseDir(dir, "MyCourse"), null, "canonical: no reorg");

  fs.mkdirSync(path.join(dir, "raw", "MyCourse"), { recursive: true });
  assert.equal(reorganizedCourseDir(dir, "MyCourse"), path.join(dir, "raw", "MyCourse"));

  const dir2 = tmpDir();
  fs.mkdirSync(path.join(dir2, ".attachments", "MyCourse"), { recursive: true });
  assert.equal(
    reorganizedCourseDir(dir2, "MyCourse"),
    path.join(dir2, ".attachments", "MyCourse")
  );
});

test("wiki.build is idempotent: a resumed run merges new/updated files into raw/", () => {
  const dir = tmpDir();

  // First scrape + reorg.
  writeCourse(dir, { "MyCourse/ASSIGNMENTS/HW/a.pdf": "v1" });
  wiki.build(dir);
  assert.equal(
    fs.readFileSync(path.join(dir, "raw", "MyCourse", "ASSIGNMENTS", "HW", "a.pdf"), "utf8"),
    "v1"
  );

  // A resumed run wrote directly into raw/MyCourse (via reorganizedCourseDir),
  // but also picture a mixed state where a canonical MyCourse/ reappears with an
  // updated a.pdf and a new b.pdf (e.g. --fresh leftovers or an interrupted
  // reorg). build() must merge rather than throw ENOTEMPTY.
  writeCourse(dir, {
    "MyCourse/ASSIGNMENTS/HW/a.pdf": "v2",
    "MyCourse/ASSIGNMENTS/HW/b.pdf": "new",
  });
  wiki.build(dir);

  const rawHw = path.join(dir, "raw", "MyCourse", "ASSIGNMENTS", "HW");
  assert.equal(fs.readFileSync(path.join(rawHw, "a.pdf"), "utf8"), "v2", "updated file overwrote");
  assert.equal(fs.readFileSync(path.join(rawHw, "b.pdf"), "utf8"), "new", "new file merged in");
  assert.equal(fs.existsSync(path.join(dir, "MyCourse")), false, "canonical folder consumed");
});

test("octarine.build is idempotent: a resumed run merges into .attachments/", () => {
  const dir = tmpDir();

  writeCourse(dir, { "MyCourse/MODULES/U1/slides.pdf": "v1" });
  octarine.build(dir, [{ courseName: "MyCourse" }]);
  const attachU1 = path.join(dir, ".attachments", "MyCourse", "MODULES", "U1");
  assert.equal(fs.readFileSync(path.join(attachU1, "slides.pdf"), "utf8"), "v1");

  writeCourse(dir, {
    "MyCourse/MODULES/U1/slides.pdf": "v2",
    "MyCourse/MODULES/U1/notes.pdf": "new",
  });
  octarine.build(dir, [{ courseName: "MyCourse" }]);

  assert.equal(fs.readFileSync(path.join(attachU1, "slides.pdf"), "utf8"), "v2");
  assert.equal(fs.readFileSync(path.join(attachU1, "notes.pdf"), "utf8"), "new");
  assert.equal(fs.existsSync(path.join(dir, "MyCourse")), false);
});
