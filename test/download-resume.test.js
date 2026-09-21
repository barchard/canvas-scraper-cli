import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";

import helpers from "../scrapers/helpers.js";
import manifest, { normalizeUrl } from "../scrapers/manifest.js";

// Keep test output quiet.
helpers.setPrinter(() => {});

// A real local HTTP server so these tests exercise the true fetch -> stream ->
// manifest -> skip path (no browser, no mocking of node-fetch). `hits` counts
// requests per path so a test can prove a re-run made no network call.
let server;
let base;
let hits;

const FILE_BODY = Buffer.from("PDF-CONTENT-0123456789");

before(async () => {
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url.startsWith("/file")) {
      res.writeHead(200, {
        "content-disposition": 'attachment; filename="doc.pdf"',
        "content-length": String(FILE_BODY.length),
        "content-type": "application/pdf",
        etag: '"v1"',
      });
      res.end(FILE_BODY);
    } else if (req.url.startsWith("/nodisp")) {
      // 200 but no content-disposition — looks like an error page, not a file.
      const body = Buffer.from("<html>not a file</html>");
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  hits = {};
  helpers.setDryRun(false);
});

function startCourse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-resume-test-"));
  manifest.reset();
  manifest.setForce(false);
  manifest.load(dir, "https://x.edu/courses/1");
  helpers.resetCreatedDirs();
  return dir;
}

test("downloadFile fetches, writes the file, and records it in the manifest", async () => {
  const dir = startCourse();
  const url = `${base}/file/1`;
  const ok = await helpers.downloadFile(url, [], dir, "backup.txt");

  assert.equal(ok, true);
  assert.equal(hits[`/file/1`], 1, "fetched once");
  assert.deepEqual(fs.readFileSync(path.join(dir, "doc.pdf")), FILE_BODY);
  const entry = manifest.assets[normalizeUrl(url)];
  assert.equal(entry.path, "doc.pdf");
  assert.equal(entry.bytes, FILE_BODY.length);
  assert.equal(entry.etag, '"v1"');
  assert.equal(entry.complete, true);
});

test("a second downloadFile of the same URL skips the network", async () => {
  const dir = startCourse();
  const url = `${base}/file/2`;
  await helpers.downloadFile(url, [], dir, "backup.txt");
  const ok = await helpers.downloadFile(url, [], dir, "backup.txt");

  assert.equal(ok, true);
  assert.equal(hits[`/file/2`], 1, "the re-run did not fetch again");
});

test("a truncated file on disk is re-downloaded", async () => {
  const dir = startCourse();
  const url = `${base}/file/3`;
  await helpers.downloadFile(url, [], dir, "backup.txt");
  assert.equal(hits[`/file/3`], 1);

  // Corrupt the file so its size no longer matches the recorded byte count.
  fs.writeFileSync(path.join(dir, "doc.pdf"), "truncated");
  const ok = await helpers.downloadFile(url, [], dir, "backup.txt");

  assert.equal(ok, true);
  assert.equal(hits[`/file/3`], 2, "size mismatch forced a re-download");
  assert.deepEqual(fs.readFileSync(path.join(dir, "doc.pdf")), FILE_BODY, "restored");
});

test("--force re-downloads even when the manifest says complete", async () => {
  const dir = startCourse();
  const url = `${base}/file/4`;
  await helpers.downloadFile(url, [], dir, "backup.txt");
  assert.equal(hits[`/file/4`], 1);

  manifest.setForce(true);
  await helpers.downloadFile(url, [], dir, "backup.txt");
  manifest.setForce(false);
  assert.equal(hits[`/file/4`], 2, "force ignored the complete entry");
});

test("downloadExternalFile downloads, records, then skips on a re-run", async () => {
  const dir = startCourse();
  const url = `${base}/file/5`;
  const ok = await helpers.downloadExternalFile(url, dir, "backup");
  assert.equal(ok, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, "doc.pdf")), FILE_BODY);
  assert.ok(manifest.assets[normalizeUrl(url)], "recorded in manifest");

  await helpers.downloadExternalFile(url, dir, "backup");
  assert.equal(hits[`/file/5`], 1, "re-run skipped the network");
});

test("a response with no content-disposition is a failure and is not recorded", async () => {
  const dir = startCourse();
  const url = `${base}/nodisp/6`;
  const ok = await helpers.downloadFile(url, [], dir, "backup.txt");

  assert.equal(ok, false, "no filename returned means a failed download");
  assert.equal(manifest.assets[normalizeUrl(url)], undefined, "not recorded complete");
});

test("dry-run never consults or writes the manifest and probes the network", async () => {
  const dir = startCourse();
  const url = `${base}/file/7`;
  // Pre-record a complete entry: a dry-run must still probe (not skip).
  fs.writeFileSync(path.join(dir, "doc.pdf"), FILE_BODY);
  manifest.record(url, path.join(dir, "doc.pdf"), { bytes: FILE_BODY.length });

  helpers.setDryRun(true);
  const ok = await helpers.downloadFile(url, [], dir, "backup.txt");
  helpers.setDryRun(false);

  assert.equal(ok, true);
  assert.equal(hits[`/file/7`], 1, "dry-run probed the network despite the manifest");
});
