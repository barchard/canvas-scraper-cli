# Cookie import for external sites (Economist & co.) — plan

Follows on from [paywall-plan.md](paywall-plan.md) Part 2 ("authorized
access"). Goal: let a user who **already has access** to The Economist, NYT,
WSJ, HBR, etc. reuse that session for articles linked from Canvas. It should
also clearly **flag** every external site that needs a login the scraper
doesn't have.

Requirements:

- **Cross-platform:** macOS, Windows and Linux, including the standalone
  `pkg` builds.
- **Browser-agnostic:** users may sign in to the publisher in Safari, Firefox,
  Chrome, Edge or anything else.
- **No elevated OS permissions:** nothing may require macOS Full Disk Access or
  admin rights. A browser's own normal prompt (e.g. a Keychain prompt) is the
  most we ask for, and only on an opt-in path.
- **Direct subscription first.** Access through an institution's library proxy
  is optional configuration (Part 5).
- **No institution names** in code, tests, fixtures, README or examples. Use
  placeholders such as `example.edu`.

## Where things stood

- `readCookies()` accepted JSON or Netscape `cookies.txt`, but the scrape took
  one file and `canvas-scraper login` overwrote it. A second source couldn't be
  layered on.
- Article pages only got cookies because Puppeteer shares one cookie store
  across pages; `archiveWebpageAsPdf` never set any.
- `detectPaywall()` already recognised `economist.com`, but a wall was reported
  the same way whether or not the user had cookies for the site.

## Part 1 — One cookie jar, merged by site

- `core/cookieJar.js`: `normalizeSite`, `filterCookiesForSites`,
  `mergeCookies` and an atomic `writeCookies`. A merge replaces every cookie on
  a domain the new batch covers and keeps everything else. A Canvas re-login
  therefore refreshes the Canvas/SSO cookies without dropping imported
  publisher cookies, and re-importing a publisher replaces its stale cookies.
- `runLogin` merges into the existing `cookies.json` instead of overwriting it.

## Part 2 — Three ways to get publisher cookies, all cross-platform

| Command | Works for | Needs |
| --- | --- | --- |
| `canvas-scraper login --site economist.com` | Everyone (any OS, any usual browser) | Nothing. A Chrome window opens at the site, the user signs in, and only that site's cookies are saved. |
| `canvas-scraper cookies import <file> --site economist.com` | Any browser with a cookie-export extension | The export file (JSON or `cookies.txt`). |
| `canvas-scraper cookies import --browser firefox --site economist.com` | Firefox users | Nothing. Firefox stores cookies unencrypted in `cookies.sqlite` in the user's own profile folder (no OS protection). Read with built-in `node:sqlite` from a temp copy, so it works while Firefox is open. |

`--site` is required for imports, so a whole browser's cookies never end up on
disk. Multiple sites are allowed (`--site economist.com,nytimes.com`).

**Safari:** reading Safari's store needs Full Disk Access, so there is no
direct Safari reader. Safari users use `login --site` (one sign-in in the
Chrome window) or a Safari cookie-export extension.

**Chrome / Edge / Brave direct read (later, opt-in):** macOS needs a Keychain
prompt ("Chrome Safe Storage") and Linux works without one. On Windows, Chrome
127+ encrypts cookies so that only Chrome itself can read them (app-bound
encryption), so Windows is not supported. Until this lands, Chrome users use
`login --site` or an extension export.

## Part 3 — Use the cookies when saving articles

- `runScrape` hands the jar to `helpers.setCookieJar()`. `archiveWebpageAsPdf`
  sets the cookies for the article's own site before loading it.
- When a page is still paywalled, the reported reason says which case it is:
  - no cookies for the site → *needs login*, with the exact
    `canvas-scraper login --site <host>` command;
  - cookies present → *session expired or not subscribed*, with the same
    re-login hint.

## Part 3b — Sites that block automated browsers

Found in testing: The Economist serves "Access is temporarily restricted …
unusual activity … automated (bot) activity" to the Puppeteer-driven Chrome,
both in the `login --site` window and when saving articles. The scraper does
**not** try to get past this (no stealth plugins, no hiding the automation
flag, no captcha solving). Instead:

- `scrapers/botwall.js` (`detectBotWall`, `botWallReason`) holds the
  detection that used to be inline in `archiveWebpageAsPdf`, plus the
  "access is temporarily restricted" / "unusual activity" / "automated (bot)
  activity" phrases.
- Article saves: a `[WARNING] BLOCKED` console line, a `bot-blocked: …`
  row in `report-skipped.csv` / `dry-run-report.csv`, and a `bot-wall` entry in
  `download-diagnostics.jsonl`. The reason points to saving the page from the
  user's own browser and running `canvas-scraper import`, not to re-logging in.
- Once a site has bot-walled one link, its other links (same host or a
  subdomain) are skipped for the rest of the run, each with its own
  `bot-blocked:` row, so Chrome isn't loading pages only to hit the same wall.
- `login --site`: a blocked site is reported, its cookies (set by the wall
  itself) are **not** saved, and the user is pointed to `cookies import`.
- Paywalled articles also get a `[WARNING] PAYWALL` console line now.

For sites like this, imported cookies may still be refused at scrape time,
because the block is on the automated browser itself. The manual importer is
the dependable route.

## Part 4 — Flag sites up front (next)

- `SITE_REGISTRY` (from `PAYWALL_SITES`) with a `kind` per publisher host.
  `describeUndownloadable()` and `detectPaywall()` both read it. Users add
  hosts via `config.json` `articleHosts`.
- `--dry-run` writes `report-sites.csv`: one row per external host with link
  count, kind, whether cookies are present, outcome counts and the fix command.
- TUI: show that summary and offer `login --site` for the listed sites.
- Outcomes `needs-login`, `paywalled`, `session-expired`, `ok-authenticated`
  as structured fields in `report.js` (Part 3 covers the reason text only).

## Part 5 — Library proxy access (optional, later)

Off by default:

```json
"libraryProxy": { "enabled": false, "prefix": "https://<your-library-proxy>/login?url=", "hosts": [] }
```

When enabled, links to the listed hosts are rewritten through the proxy, and
proxy cookies count as cookies for those hosts. Tests use `proxy.example.edu`.

## Guardrails

- Import only the sites the user names. Never write a whole browser store to
  disk.
- Cookie files stay gitignored.
- No paywall circumvention (see paywall-plan.md). Only reuse sessions the user
  legitimately holds.

## Milestones

1. **(this change)** Cookie jar merge, `login --site`, `cookies import` (file
   and Firefox), per-site cookies when saving articles, needs-login /
   session-expired hints, tests, README.
2. Site registry, `report-sites.csv`, structured outcomes, TUI summary.
3. Opt-in Chromium reader for macOS and Linux.
4. Optional library proxy.
