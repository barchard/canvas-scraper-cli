import { test } from "node:test";
import assert from "node:assert/strict";

import { detectPaywall, siteFor } from "../scrapers/paywall.js";

const NYT = "https://www.nytimes.com/2026/01/01/world/story.html";
const long = { bodyChars: 4000, paragraphs: 20, isArticle: true, ldFree: [], matchedSelectors: [], text: "" };

test("siteFor matches subdomains of known hosts and ignores others", () => {
  assert.equal(siteFor(NYT).domain, "nytimes.com");
  assert.equal(siteFor("https://example.com/a"), null);
});

test("a full free article is not paywalled", () => {
  assert.equal(detectPaywall({ url: NYT, status: 200, signals: long }).paywalled, false);
});

test("JSON-LD isAccessibleForFree=false is a high-confidence paywall", () => {
  const r = detectPaywall({ url: NYT, status: 200, signals: { ...long, ldFree: ["false"] } });
  assert.equal(r.paywalled, true);
  assert.equal(r.confidence, "high");
});

test("a known paywall element is a high-confidence paywall", () => {
  const r = detectPaywall({ url: NYT, status: 200, signals: { ...long, matchedSelectors: ["#gateway-content"] } });
  assert.equal(r.confidence, "high");
  assert.match(r.reason, /gateway-content/);
});

test("redirect to a login host is a paywall", () => {
  const r = detectPaywall({ url: NYT, finalUrl: "https://myaccount.nytimes.com/auth/login", status: 200, signals: long });
  assert.equal(r.paywalled, true);
  assert.match(r.reason, /login/);
});

test("403 from a known news host is a paywall; from an unknown host it is not", () => {
  assert.equal(detectPaywall({ url: NYT, status: 403, signals: long }).paywalled, true);
  assert.equal(detectPaywall({ url: "https://example.com/a", status: 403, signals: long }).paywalled, false);
});

test("one soft signal alone (short but free page) is not enough", () => {
  const r = detectPaywall({ url: NYT, status: 200, signals: { ...long, bodyChars: 100 } });
  assert.equal(r.paywalled, false);
});

test("short body plus subscribe wording is a medium-confidence paywall", () => {
  const r = detectPaywall({
    url: NYT,
    status: 200,
    signals: { ...long, bodyChars: 100, text: "Subscribe to continue reading" },
  });
  assert.equal(r.paywalled, true);
  assert.equal(r.confidence, "medium");
});
