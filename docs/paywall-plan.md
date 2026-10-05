# Paywalled article support — plan

## Problem

Course modules often link to news articles (NYTimes, WSJ, FT, Economist…).
Today an external-URL item is fetched like any other page, so a paywalled
article is saved as a teaser, a login wall, or a "subscribe" interstitial — and
reported as a success. We want to (1) **detect** that, and (2) get the **full
article legitimately** when the user is entitled to it.

## Scope decision

This plan covers detection and *authorized* access only:

- the user's **own subscription** (many universities provide NYT/WSJ access
  through the library or a campus SSO), via their logged-in session, and
- the **manual importer** fallback ([importer-plan.md](importer-plan.md)).

It deliberately does **not** include paywall circumvention: spoofing
Googlebot/bingbot UAs or referrers, routing through archive.today/12ft-style
proxies, blocking the paywall script to expose server-rendered text, or
scraping cached copies. Those defeat an access control the publisher put in
place, are against the sites' terms, and break constantly. Where the user has
no entitlement, the item is reported as `paywalled` and goes on the importer
worklist.

## Part 1 — Detection

New module `scrapers/paywall.js` exporting
`detectPaywall({ url, status, html, page }) → { paywalled, reason, confidence }`.
Signals, cheapest first; any hard signal wins, soft signals must combine:

| Signal | Kind | Notes |
| --- | --- | --- |
| HTTP 401/402/403 from a known news host | hard | |
| Redirect to a login/subscribe host (`myaccount.nytimes.com`, `sso.accounts.dowjones.com`, `/subscribe`, `/login`) | hard | check final URL after redirects |
| JSON-LD `isAccessibleForFree: false` / `hasPart.isAccessibleForFree: false` (schema.org `NewsArticle`) | hard | Publishers set this for SEO; the most reliable generic signal |
| Known paywall DOM: `#gateway-content`, `[data-testid="inline-message"]`, `.snippet-promotion`, `#cx-scrim`, `.wsj-snippet-login` | hard | per-site table in `PAYWALL_SELECTORS`, easy to extend |
| Extracted body text below threshold (< ~600 chars / < 3 paragraphs) while `<title>`/`og:description` indicate an article | soft | |
| Phrases like "subscribe to continue", "you have reached your article limit" | soft | |

Output `confidence` of `high` (≥1 hard signal) or `medium` (≥2 soft). Only
`high` changes behaviour automatically; `medium` is logged and flagged.

Per-host config lives in a `PAYWALL_SITES` map (`nytimes.com`, `wsj.com`, `ft.com`,
`economist.com`, `washingtonpost.com`, `bloomberg.com`, `hbr.org`) holding
selectors, login-host patterns and the cookie domains needed.

## Part 2 — Authorized access

Reuse the existing cookie machinery rather than inventing anything:

1. **Cookie capture.** `core/login.js` already has `LOGIN_STRATEGIES` and a
   `videoHosts`-style list of non-Canvas hosts whose cookies get captured.
   Add `articleHosts` (config.json, default `[]`) and a
   `canvas-scraper login --site nytimes.com` flow that opens a real browser,
   lets the user sign in (library SSO included, 2FA and all), and stores those
   cookies alongside the Canvas ones. Never handle passwords in the tool.
2. **Fetch with session.** In the external-link path, load the page in
   puppeteer with the stored cookies for that host (`launchBrowser` +
   `page.setCookie`), wait for `networkidle2`, then run `detectPaywall`.
3. **Capture format.** Save the article as both:
   - **PDF** via `page.pdf()` after removing cookie banners / sticky nags
     (cosmetic only — never to reveal gated text), and
   - **Markdown/HTML** of the article body (`article` / JSON-LD `articleBody`
     when present) so it works with `--wiki` / `--octarine` layouts.
4. **Session expiry.** If a page that *was* accessible now detects as
   paywalled and we hold cookies for the host, report `session-expired`
   (distinct from `paywalled`) with the hint to re-run `login --site`. Mirror
   the Panopto/Study.Net session-check and failure reporting from commit
   `00fea8d`.
5. **Rate/politeness.** Per-host concurrency of 1, small jitter between
   fetches, no retries on `paywalled` (retrying can burn the user's article
   quota or trigger bot detection).

## Part 3 — Reporting & fallback

- New outcomes in `scrapers/report.js`: `paywalled`, `session-expired`
  (and `needs-login` when no cookies exist for the host). Surface them in
  `report-skipped.csv` and `download-diagnostics.jsonl` exactly like other
  skips, with the URL and detection `reason`.
- Do **not** save the teaser as the item's content; write nothing (or a stub
  `.url` file) so the manifest/resume logic (`scrapers/manifest.js`) treats it
  as incomplete and retries after the user logs in.
- Importer: paywalled items appear on the importer worklist so the user can
  drop in a PDF they saved from their own browser.

## Files touched

- `scrapers/paywall.js` — new: `detectPaywall`, `PAYWALL_SITES`.
- `scrapers/articles/index.js` — new: fetch-with-cookies, detect, PDF/MD capture
  (hooked from wherever modules currently handle external URLs).
- `core/login.js` — `--site` capture; `articleHosts` from config.
- `scrapers/report.js`, `core/import.js` — new outcomes, worklist entries.
- `README.md`, `cookies-example.json`, `config.json` — document `articleHosts`.
- `test/paywall.test.js` — new.

## Testing

- `detectPaywall` unit tests against saved HTML fixtures (sanitized snippets
  checked into `test/fixtures/paywall/`): free article, metered wall, hard
  login redirect, JSON-LD `isAccessibleForFree:false`, short-but-free page
  (false-positive guard).
- Outcome mapping tests (`paywalled` / `session-expired` / `needs-login`) in
  the style of `test/video-outcome.test.js`.
- Manual: one real run with a valid subscription session and one without.

## Milestones

1. `paywall.js` + fixtures + tests; wire detection only, so teasers stop being
   reported as successes (ships value on its own).
2. `login --site` and cookie-backed fetch + PDF/MD capture.
3. `session-expired` handling, importer worklist integration, docs.

## Decisions

- Libraries provide NYT/WSJ access, so cookie-backed fetch (Part 2) stays the
  supported route to full text; it is optional and ships after detection.
- Capture **both** PDF and Markdown for every accessible article.
- Detect and **report** paywalled articles (`report-skipped.csv`) for review.

## Status

- Milestone 1 done: `scrapers/paywall.js`, `scrapers/articleMarkdown.js`,
  hooked into `archiveWebpageAsPdf` (paywalled pages are reported and not
  archived; accessible pages get a PDF plus a `.md`), `test/paywall.test.js`.
- Remaining: `login --site` + cookie-backed fetch, `session-expired` /
  `needs-login` outcomes, importer worklist integration, docs.
