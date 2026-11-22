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

test("browserResponds: true for a live Chrome, false for a hung or dead one", async () => {
  const live = fakeBrowser();
  live.version = async () => "Chrome/1";
  assert.equal(await helpers.browserResponds(live, 1000), true);

  const hung = fakeBrowser();
  hung.version = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await helpers.browserResponds(hung, 50), false);
  assert.ok(Date.now() - started < 1000);

  const dead = fakeBrowser();
  dead.isConnected = () => false;
  dead.version = async () => "Chrome/1";
  assert.equal(await helpers.browserResponds(dead, 1000), false);
});

test("untilDisconnected rejects when Chrome goes away, and cancel() removes the listener", async () => {
  const b = fakeBrowser();
  const gone = helpers.untilDisconnected(b);
  assert.equal(b.listenerCount("disconnected"), 1);
  setTimeout(() => b.emit("disconnected"), 10);
  await assert.rejects(gone.promise, /Browser has disconnected/);
  gone.cancel();
  assert.equal(b.listenerCount("disconnected"), 0);

  const dead = fakeBrowser();
  dead.isConnected = () => false;
  await assert.rejects(helpers.untilDisconnected(dead).promise, /disconnected/);
});

test("a bot-blocked site's other links are skipped for the rest of the run", () => {
  helpers.resetBlocked();
  const first = "https://www.example.com/news/one";
  helpers.rememberBlockedSite(first, "bot-blocked: example.com blocked the automated browser");

  // same site, with or without www, and its subdomains
  for (const u of [
    "https://www.example.com/news/two",
    "https://example.com/three",
    "https://markets.example.com/four",
  ]) {
    const site = helpers.blockedSiteFor(u);
    assert.equal(site && site.host, "example.com", u);
    assert.match(helpers.blockedReason(u), /example\.com blocked the automated browser earlier in this run/);
    assert.match(helpers.blockedReason(u), /canvas-scraper import/);
  }

  // other sites, and look-alike hosts, are not affected
  assert.equal(helpers.blockedSiteFor("https://www.example.org/x"), null);
  assert.equal(helpers.blockedSiteFor("https://notexample.com/x"), null);
  assert.equal(helpers.blockedReason("https://www.example.org/x"), "");

  // a link-specific reason (e.g. the first link's own result) wins
  helpers.rememberBlocked(first, "bot-blocked: example.com blocked the automated browser (\"just a moment\")");
  assert.match(helpers.blockedReason(first), /just a moment/);

  helpers.resetBlocked();
  assert.equal(helpers.blockedSiteFor("https://www.example.com/news/two"), null);
});

test("archiveWebpageAsPdf skips a blocked site without opening a tab", async () => {
  helpers.resetBlocked();
  helpers.rememberBlockedSite("https://www.example.com/a", "bot-blocked: example.com");
  let opened = false;
  const b = fakeBrowser();
  b.createBrowserContext = async () => {
    opened = true;
    throw new Error("should not open");
  };
  assert.equal(await helpers.archiveWebpageAsPdf(b, "https://www.example.com/b", "/tmp", "x"), false);
  assert.equal(opened, false);
  helpers.resetBlocked();
});
