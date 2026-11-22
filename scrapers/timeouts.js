/**
 * How long the scraper waits for things before giving up, in seconds.
 * Override any of them in config.json:
 *
 *   "timeouts": { "chromeRequest": 600, "siteResponse": 60 }
 */
export const TIMEOUT_DEFAULTS = {
  // Any single request to Chrome (opening a tab, rendering a PDF, ...). A
  // request Chrome never answers fails after this long.
  chromeRequest: 300,
  // Opening a new Chrome tab.
  openTab: 300,
  // Loading a Canvas page.
  pageLoad: 60,
  // Loading an outside article before saving it as a PDF.
  articleLoad: 30,
  // An outside site starting to answer a download request.
  siteResponse: 30,
  // A download that stops sending data.
  downloadStall: 60,
  // Checking that Chrome still answers before restarting it.
  chromeCheck: 30,
};

/** What each setting is called in messages. */
export const TIMEOUT_LABELS = {
  chromeRequest: "a Chrome request",
  openTab: "opening a Chrome tab",
  pageLoad: "a Canvas page load",
  articleLoad: "an article load",
  siteResponse: "a site's response",
  downloadStall: "a stalled download",
  chromeCheck: "the Chrome health check",
};

/**
 * Merges config.json `timeouts` (seconds) over the defaults.
 * Unknown names and values that aren't positive numbers are reported in
 * `warnings` and ignored.
 * @param {object} [config] the whole config.json object
 * @returns {{seconds: Record<string, number>, ms: Record<string, number>, warnings: string[]}}
 */
export function resolveTimeouts(config = {}) {
  const seconds = { ...TIMEOUT_DEFAULTS };
  const warnings = [];
  const given = config && config.timeouts;
  if (given != null && (typeof given !== "object" || Array.isArray(given))) {
    warnings.push(`config.json "timeouts" should be an object of seconds, e.g. { "chromeRequest": 600 }; using defaults`);
  } else if (given) {
    for (const [name, value] of Object.entries(given)) {
      if (!(name in TIMEOUT_DEFAULTS)) {
        warnings.push(`config.json timeouts.${name} isn't a known setting (known: ${Object.keys(TIMEOUT_DEFAULTS).join(", ")}); ignored`);
        continue;
      }
      const n = Number(value);
      if (typeof value === "boolean" || value === null || value === "" || !Number.isFinite(n) || n <= 0) {
        warnings.push(`config.json timeouts.${name} must be a positive number of seconds (got ${JSON.stringify(value)}); using ${TIMEOUT_DEFAULTS[name]}`);
        continue;
      }
      seconds[name] = n;
    }
  }
  const ms = Object.fromEntries(Object.entries(seconds).map(([k, v]) => [k, Math.round(v * 1000)]));
  return { seconds, ms, warnings };
}
