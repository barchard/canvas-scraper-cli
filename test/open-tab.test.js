import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";

import helpers from "../scrapers/helpers.js";

helpers.setPrinter(() => {});

/** A stand-in for a puppeteer Browser whose newPage() we control. */
function fakeBrowser(newPage) {
  const b = new EventEmitter();
  b.connected = true;
  b.isConnected = () => b.connected;
  b.newPage = newPage;
  b.kill = () => {
    b.connected = false;
    b.emit("disconnected");
  };
  return b;
}

// Same test as core/scrape.js isBrowserFault, so a rejection relaunches Chrome.
const isBrowserFault = (e) =>
  /timed out|protocolTimeout|Target closed|Session closed|Connection closed|Browser has disconnected/i.test(
    (e && e.message) || ""
  );

test("openTab resolves with the page when newPage succeeds", async () => {
  const page = { close: async () => {} };
  const b = fakeBrowser(async () => page);
  assert.equal(await helpers.openTab(b, 1000), page);
  assert.equal(b.listenerCount("disconnected"), 0, "listener cleaned up");
});

test("openTab rejects at once when Chrome dies while a tab is opening (the hang)", async () => {
  // Puppeteer's newPage() never settles if tab initialization fails.
  const b = fakeBrowser(() => new Promise(() => {}));
  const p = helpers.openTab(b, 60000);
  setTimeout(() => b.kill(), 20);
  const started = Date.now();
  await assert.rejects(p, (e) => isBrowserFault(e) && /disconnected/.test(e.message));
  assert.ok(Date.now() - started < 1000);
  assert.equal(b.listenerCount("disconnected"), 0);
});

test("openTab rejects immediately on an already-dead browser", async () => {
  let called = false;
  const b = fakeBrowser(async () => {
    called = true;
  });
  b.connected = false;
  await assert.rejects(helpers.openTab(b, 1000), /disconnected/);
  assert.equal(called, false);
});

test("openTab times out as a browser fault and closes a tab that opens late", async () => {
  let closed = false;
  let finish;
  const b = fakeBrowser(() => new Promise((r) => (finish = r)));
  await assert.rejects(helpers.openTab(b, 50), (e) => isBrowserFault(e) && /timed out/.test(e.message));
  finish({ close: async () => (closed = true) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, true);
});

test("openTab passes newPage errors through", async () => {
  const b = fakeBrowser(async () => {
    throw new Error("Target.createTarget failed");
  });
  await assert.rejects(helpers.openTab(b, 1000), /createTarget failed/);
});

test("browserGone reflects the connection state", () => {
  const b = fakeBrowser(async () => ({}));
  assert.equal(helpers.browserGone(b), false);
  b.kill();
  assert.equal(helpers.browserGone(b), true);
  assert.equal(helpers.browserGone(null), false);
});
