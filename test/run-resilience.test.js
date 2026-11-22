import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";

import helpers from "../scrapers/helpers.js";
import { describeCourseSummary } from "../core/scrape.js";

helpers.setPrinter(() => {});

/** A stand-in browser whose contexts and pages record being closed. */
function fakeBrowser() {
  const b = new EventEmitter();
  b.isConnected = () => true;
  b.contexts = [];
  b.defaultPages = [];
  b.newPage = async () => {
    const p = { closed: false, close: async () => (p.closed = true) };
    b.defaultPages.push(p);
    return p;
  };
  b.createBrowserContext = async () => {
    const ctx = { closed: false, close: async () => (ctx.closed = true) };
    ctx.newPage = async () => ({ ctx, close: async () => {} });
    b.contexts.push(ctx);
    return ctx;
  };
  return b;
}

test("openIsolatedTab opens the tab in its own context and closeTab closes the context", async () => {
  const b = fakeBrowser();
  const page = await helpers.openIsolatedTab(b, 1000);
  assert.equal(b.contexts.length, 1);
  assert.equal(page.ctx, b.contexts[0]);
  await helpers.closeTab(page);
  assert.equal(b.contexts[0].closed, true);
  assert.equal(b.listenerCount("disconnected"), 0);
});

test("openIsolatedTab closes the context if the tab can't be created", async () => {
  const b = fakeBrowser();
  b.createBrowserContext = async () => {
    const ctx = { closed: false, close: async () => (ctx.closed = true) };
    ctx.newPage = async () => {
      throw new Error("Target.createTarget failed");
    };
    b.contexts.push(ctx);
    return ctx;
  };
  await assert.rejects(helpers.openIsolatedTab(b, 1000), /createTarget failed/);
  assert.equal(b.contexts[0].closed, true);
});

test("openIsolatedTab falls back to a normal tab on browsers without contexts", async () => {
  const b = fakeBrowser();
  delete b.createBrowserContext;
  const page = await helpers.openIsolatedTab(b, 1000);
  await helpers.closeTab(page);
  assert.equal(b.defaultPages[0].closed, true);
});

test("closeTab on a normal tab just closes the page, and tolerates null", async () => {
  const b = fakeBrowser();
  const page = await helpers.openTab(b, 1000);
  await helpers.closeTab(page);
  assert.equal(page.closed, true);
  await helpers.closeTab(null);
});

test("blocked links are remembered for the run and forgotten on reset", () => {
  helpers.resetBlocked();
  const url = "https://www.example.com/article";
  assert.equal(helpers.blockedReason(url), "");
  helpers.rememberBlocked(url, "bot-blocked: example.com blocked the automated browser");
  assert.match(helpers.blockedReason(url), /bot-blocked/);
  helpers.resetBlocked();
  assert.equal(helpers.blockedReason(url), "");
});

test("describeCourseSummary: all courses finished", () => {
  assert.equal(describeCourseSummary({ courseCount: 2, courseTotal: 2, failedCourses: [] }), "Scraped 2 course(s).");
  assert.match(
    describeCourseSummary({ courseCount: 1, courseTotal: 1, failedCourses: [], dryRun: true }),
    /Dry run complete — probed 1 course/
  );
});

test("describeCourseSummary: a failed course is named, not just counted as zero", () => {
  const line = describeCourseSummary({
    courseCount: 0,
    courseTotal: 1,
    failedCourses: [{ id: 1, name: "Example Course", error: "Browser has disconnected" }],
  });
  assert.match(line, /Scraped 0 of 1 course\(s\); 1 didn't finish: Example Course/);
  assert.match(line, /errors\.csv/);
});
