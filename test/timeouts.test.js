import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { PassThrough } from "stream";

import helpers from "../scrapers/helpers.js";

helpers.setPrinter(() => {});

/** A server that accepts connections and never answers (like a tarpitting site). */
async function silentServer() {
  const sockets = new Set();
  const server = http.createServer(() => {
    /* never respond */
  });
  server.on("connection", (s) => sockets.add(s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/article`,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

test("fetchWithTimeout gives up on a site that never responds", async () => {
  const srv = await silentServer();
  try {
    const started = Date.now();
    await assert.rejects(helpers.fetchWithTimeout(srv.url, {}, 200), (e) => {
      assert.equal(e.code, "ETIMEDOUT");
      assert.match(e.message, /no response from 127\.0\.0\.1 within 0s|no response from 127\.0\.0\.1/);
      return true;
    });
    assert.ok(Date.now() - started < 5000, "should not wait for the OS socket timeout");
  } finally {
    await srv.close();
  }
});

test("fetchWithTimeout returns normally when the site answers in time", async () => {
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await helpers.fetchWithTimeout(`http://127.0.0.1:${server.address().port}/`, {}, 2000);
    assert.equal(await res.text(), "ok");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("downloadExternalFile reports a timeout instead of hanging", async () => {
  const srv = await silentServer();
  const prev = helpers.externalResponseTimeoutMs;
  helpers.externalResponseTimeoutMs = 200;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-test-"));
  try {
    assert.equal(await helpers.downloadExternalFile(srv.url, dir, "x"), false);
  } finally {
    helpers.externalResponseTimeoutMs = prev;
    await srv.close();
  }
});

test("streamToFile abandons a download that stops sending data", async () => {
  const prev = helpers.streamIdleTimeoutMs;
  helpers.streamIdleTimeoutMs = 150;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-test-"));
  const body = new PassThrough();
  const response = { headers: { get: () => null }, body };
  try {
    const p = helpers.streamToFile(response, path.join(dir, "f.pdf"), "f.pdf");
    body.write("partial");
    await assert.rejects(p, (e) => e.code === "ETIMEDOUT" && /stalled/.test(e.message));
    // no file and no stranded .part left behind
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    helpers.streamIdleTimeoutMs = prev;
  }
});

test("streamToFile still completes a slow download that keeps moving", async () => {
  const prev = helpers.streamIdleTimeoutMs;
  helpers.streamIdleTimeoutMs = 200;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-test-"));
  const body = new PassThrough();
  const response = { headers: { get: () => null }, body };
  try {
    const p = helpers.streamToFile(response, path.join(dir, "f.txt"), "f.txt");
    for (let i = 0; i < 4; i++) {
      body.write(`chunk${i}`);
      await new Promise((r) => setTimeout(r, 100)); // total 400ms > idle limit
    }
    body.end();
    await p;
    assert.equal(fs.readFileSync(path.join(dir, "f.txt"), "utf8"), "chunk0chunk1chunk2chunk3");
  } finally {
    helpers.streamIdleTimeoutMs = prev;
  }
});
