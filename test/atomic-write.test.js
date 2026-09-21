import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable, PassThrough } from "stream";

import helpers from "../scrapers/helpers.js";

// Keep test output quiet.
helpers.setPrinter(() => {});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
}

// A minimal node-fetch-like response wrapper around a readable body.
function fakeResponse(body, headers = {}) {
  return {
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body,
  };
}

test("streamToFile writes the whole file and leaves no .part behind", async () => {
  const dir = tmpDir();
  const dest = path.join(dir, "note.txt");
  const body = Readable.from(["hello ", "world"]);
  await helpers.streamToFile(fakeResponse(body, { "content-length": "11" }), dest, "note.txt");

  assert.equal(fs.readFileSync(dest, "utf8"), "hello world");
  assert.equal(fs.existsSync(dest + ".part"), false, "no leftover .part");
});

test("streamToFile leaves no truncated final file when the body errors mid-stream", async () => {
  const dir = tmpDir();
  const dest = path.join(dir, "partial.bin");

  // Emit one chunk, then error — simulating a dropped connection / Ctrl-C.
  const body = new PassThrough();
  setImmediate(() => {
    body.write("first chunk");
    body.emit("error", new Error("connection reset"));
  });

  await assert.rejects(
    helpers.streamToFile(fakeResponse(body, { "content-length": "999" }), dest, "partial.bin"),
    /connection reset/
  );

  // The whole point of Phase 1: an interrupted download must NOT leave a
  // truncated file at the real path for a resumed run to trust as complete.
  assert.equal(fs.existsSync(dest), false, "no truncated final file");
  assert.equal(fs.existsSync(dest + ".part"), false, "no leftover .part");
});

test("writeFile writes atomically and cleans up on success", async () => {
  const dir = tmpDir();
  await helpers.writeFile(dir, "page.html", "<html>ok</html>");

  const dest = path.join(dir, "page.html");
  assert.equal(fs.readFileSync(dest, "utf8"), "<html>ok</html>");
  assert.equal(fs.existsSync(dest + ".part"), false, "no leftover .part");
});

test("writeFile in dry-run writes nothing", async () => {
  const dir = tmpDir();
  helpers.setDryRun(true);
  try {
    await helpers.writeFile(dir, "skip.txt", "data");
  } finally {
    helpers.setDryRun(false);
  }
  assert.equal(fs.existsSync(path.join(dir, "skip.txt")), false);
});
