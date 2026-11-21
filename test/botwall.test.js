import { test } from "node:test";
import assert from "node:assert/strict";

import { detectBotWall, botWallReason, siteHost } from "../scrapers/botwall.js";

const pad = (n) => " filler text".repeat(Math.ceil(n / 12)).slice(0, n);

// Shape of the interstitial a publisher serves to automated browsers.
const RESTRICTED =
  "The Economist\nAccess is temporarily restricted\nWe detected unusual activity from your device or network.\n" +
  "Reasons may include:\n- Rapid taps or clicks\n- JavaScript disabled or not working\n" +
  "- Automated (bot) activity on your network (IP 203.0.113.7)\n- Use of developer or inspection tools\n" +
  "Need help? Submit feedback.";

test("a publisher's 'access is temporarily restricted' page is a bot wall", () => {
  const w = detectBotWall({ title: "economist.com", text: RESTRICTED });
  assert.equal(w.blocked, true);
  assert.equal(w.kind, "interstitial");
  assert.match(w.match, /access is temporarily restricted|unusual activity/);
});

test("classic interstitials are bot walls", () => {
  for (const text of ["Just a moment...", "Are you a robot?", "Please verify you are a human", "Request blocked"]) {
    assert.equal(detectBotWall({ text: `${text}${pad(250)}` }).blocked, true, text);
  }
});

test("a near-empty page counts as blocked", () => {
  const w = detectBotWall({ title: "x", text: "   " });
  assert.deepEqual(w, { blocked: true, kind: "empty", match: "" });
});

test("a full article that mentions bots or captchas is not blocked", () => {
  const text = `An essay about CAPTCHAs, unusual traffic and bot detection. ${pad(1500)}`;
  assert.equal(detectBotWall({ text }).blocked, false);
});

test("a passive 'protected by reCAPTCHA' footer is not a challenge", () => {
  const text = `Sign up for our newsletter. This site is protected by reCAPTCHA. ${pad(400)}`;
  assert.equal(detectBotWall({ text }).blocked, false);
});

test("botWallReason names the site and points to import, not login", () => {
  const url = "https://www.economist.com/finance/2026/01/01/x";
  const r = botWallReason(url, { kind: "interstitial", match: "access is temporarily restricted" });
  assert.match(r, /^bot-blocked: economist\.com blocked the automated browser/);
  assert.match(r, /canvas-scraper import/);
  assert.doesNotMatch(r, /login --site/);
  assert.match(botWallReason(url, { kind: "empty", match: "" }), /rendered an empty page/);
});

test("siteHost drops www and tolerates bad URLs", () => {
  assert.equal(siteHost("https://www.Example.com/a"), "example.com");
  assert.equal(siteHost("nope"), "");
});
