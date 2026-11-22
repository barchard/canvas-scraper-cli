import { test } from "node:test";
import assert from "node:assert/strict";

import waits, { fmtClock, formatWait, SHOW_WAIT_AFTER_MS, SHOW_IDLE_AFTER_MS } from "../scrapers/waits.js";
import { resolveTimeouts, TIMEOUT_DEFAULTS } from "../scrapers/timeouts.js";
import helpers from "../scrapers/helpers.js";

helpers.setPrinter(() => {});

test("fmtClock formats minutes and hours", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(75000), "1:15");
  assert.equal(fmtClock(3723000), "1:02:03");
});

test("a known wait shows a timer with its limit after a few seconds", () => {
  waits.reset(0);
  const id = waits.begin("www.example.com to load", 30000, 1000);
  assert.equal(waits.describe(1000 + SHOW_WAIT_AFTER_MS - 1), null, "short waits stay quiet");
  const w = waits.describe(13000);
  assert.deepEqual(w, { kind: "wait", label: "www.example.com to load", elapsedMs: 12000, limitMs: 30000 });
  assert.equal(formatWait(w), "⏳ Waiting for www.example.com to load — 0:12 (gives up at 0:30)");
  waits.end(id, 13000);
  assert.equal(waits.describe(14000), null);
});

test("the innermost (latest) wait is the one shown", () => {
  waits.reset(0);
  waits.begin("Chrome to open a tab", 300000, 0);
  waits.begin("www.example.com to load", 30000, 2000);
  assert.match(formatWait(waits.describe(10000)), /www\.example\.com to load — 0:08/);
});

test("with no known wait, quiet output shows as idle time with the last line", () => {
  waits.reset(0);
  waits.idleLimitMs = 300000;
  waits.noteActivity("[NOTE] QUIZ 'Quiz 1' | STARTING SCRAPING", 0);
  assert.equal(waits.describe(SHOW_IDLE_AFTER_MS - 1), null);
  assert.equal(
    formatWait(waits.describe(65000)),
    "⏳ No new output for 1:05 (stuck Chrome requests give up at 5:00) — last: [NOTE] QUIZ 'Quiz 1' | STARTING SCRAPING"
  );
  waits.noteActivity("", 65000);
  assert.equal(waits.describe(66000), null);
});

test("track() ends the wait even when the work throws", async () => {
  waits.reset();
  await assert.rejects(waits.track("x", 1000, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(waits.active.size, 0);
});

test("helpers.print counts as activity", () => {
  waits.reset(0);
  helpers.print("NOTE", "TEST", "hello", 0);
  assert.ok(Date.now() - waits.lastActivityAt < 1000);
  assert.match(waits.lastLine, /TEST \| hello/);
});

test("resolveTimeouts: defaults, overrides in seconds, and bad values", () => {
  const d = resolveTimeouts({});
  assert.deepEqual(d.seconds, TIMEOUT_DEFAULTS);
  assert.equal(d.ms.chromeRequest, 300000);
  assert.deepEqual(d.warnings, []);

  const r = resolveTimeouts({
    timeouts: { chromeRequest: 600, siteResponse: "45", articleLoad: 0, pageLoad: "soon", bogus: 5 },
  });
  assert.equal(r.ms.chromeRequest, 600000);
  assert.equal(r.ms.siteResponse, 45000);
  assert.equal(r.ms.articleLoad, 30000, "invalid falls back to default");
  assert.equal(r.ms.pageLoad, 60000);
  assert.equal(r.warnings.length, 3);
  assert.ok(r.warnings.some((w) => /bogus/.test(w)));

  assert.equal(resolveTimeouts({ timeouts: 30 }).warnings.length, 1);
});

test("helpers.setTimeouts applies config values", () => {
  const before = { ...helpers };
  try {
    helpers.setTimeouts({ timeouts: { openTab: 120, downloadStall: 90, chromeRequest: 400 } });
    assert.equal(helpers.openTabTimeoutMs, 120000);
    assert.equal(helpers.streamIdleTimeoutMs, 90000);
    assert.equal(helpers.protocolTimeoutMs, 400000);
    assert.equal(waits.idleLimitMs, 400000);
  } finally {
    helpers.setTimeouts({});
    assert.equal(helpers.openTabTimeoutMs, before.openTabTimeoutMs);
  }
});
