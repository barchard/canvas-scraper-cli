import test from "node:test";
import assert from "node:assert/strict";

import helpers from "../scrapers/helpers.js";

// Keep the tests fast and silent: near-zero backoff and a no-op printer.
function fastRetries(retries) {
  helpers.setRetryConfig({ retries, baseDelay: 1 });
  helpers.setPrinter(() => {});
}

test.afterEach(() => {
  helpers.setRetryConfig({ retries: 0, baseDelay: 2000 });
  helpers.setPrinter(null);
});

test("isRetryableHttpStatus retries only 408/425/429/5xx", () => {
  assert.equal(helpers.isRetryableHttpStatus(401), false);
  assert.equal(helpers.isRetryableHttpStatus(403), false);
  assert.equal(helpers.isRetryableHttpStatus(404), false);
  assert.equal(helpers.isRetryableHttpStatus(408), true);
  assert.equal(helpers.isRetryableHttpStatus(425), true);
  assert.equal(helpers.isRetryableHttpStatus(429), true);
  assert.equal(helpers.isRetryableHttpStatus(500), true);
  assert.equal(helpers.isRetryableHttpStatus(503), true);
});

test("isRetryableYtDlpFailure treats gone/blocked content as permanent", () => {
  assert.equal(helpers.isRetryableYtDlpFailure("ERROR: Private video"), false);
  assert.equal(
    helpers.isRetryableYtDlpFailure("ERROR: Video unavailable"),
    false
  );
  assert.equal(
    helpers.isRetryableYtDlpFailure("ERROR: Unsupported URL: https://x/y"),
    false
  );
});

test("isRetryableYtDlpFailure treats network/rate-limit/bot-check as transient", () => {
  assert.equal(
    helpers.isRetryableYtDlpFailure(
      "ERROR: Sign in to confirm you're not a bot"
    ),
    true
  );
  assert.equal(
    helpers.isRetryableYtDlpFailure("Unable to download webpage: HTTP Error 429"),
    true
  );
  assert.equal(
    helpers.isRetryableYtDlpFailure("ERROR: unable to download video data"),
    true
  );
});

test("withRetry succeeds after transient failures and reports attempt count", async () => {
  fastRetries(3);
  let calls = 0;
  const res = await helpers.withRetry(async () => {
    calls += 1;
    return calls >= 3 ? { ok: true } : { ok: false };
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(calls, 3);
});

test("withRetry stops immediately on a permanent (retryable:false) failure", async () => {
  fastRetries(5);
  let calls = 0;
  const res = await helpers.withRetry(async () => {
    calls += 1;
    return { ok: false, retryable: false, reason: "gone" };
  });
  assert.equal(res.ok, false);
  assert.equal(calls, 1);
  assert.equal(res.last.reason, "gone");
});

test("withRetry gives up after retries+1 attempts on a persistent failure", async () => {
  fastRetries(2);
  let calls = 0;
  const res = await helpers.withRetry(async () => {
    calls += 1;
    return { ok: false, reason: "flaky" };
  });
  assert.equal(res.ok, false);
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test("withRetry treats a thrown error as a transient failure", async () => {
  fastRetries(1);
  let calls = 0;
  const res = await helpers.withRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return { ok: true };
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
});

test("withRetry with retries:0 makes a single attempt", async () => {
  fastRetries(0);
  let calls = 0;
  const res = await helpers.withRetry(async () => {
    calls += 1;
    return { ok: false };
  });
  assert.equal(res.ok, false);
  assert.equal(calls, 1);
});
