/**
 * Paywall detection for external article links.
 *
 * Detection only: it classifies a rendered page as paywalled so the scraper can
 * report it for follow-up (library login, manual import) instead of saving a
 * subscribe teaser as if it were the article.
 */

/** Per-host paywall config: DOM markers and login/subscribe redirect patterns. */
export const PAYWALL_SITES = {
  "nytimes.com": {
    selectors: ["#gateway-content", "[data-testid='inline-message']", ".snippet-promotion", "#standalone-header-gateway"],
    loginHosts: ["myaccount.nytimes.com"],
  },
  "wsj.com": {
    selectors: ["#cx-snippet-overlay", ".snippet-promotion", ".wsj-snippet-login", "#cx-scrim"],
    loginHosts: ["sso.accounts.dowjones.com", "accounts.wsj.com"],
  },
  "ft.com": { selectors: [".o-banner__outer", "[data-component='subscribe-banner']"], loginHosts: ["accounts.ft.com"] },
  "economist.com": { selectors: ["#paywall", "[data-test-id='paywall']"], loginHosts: ["authenticate.economist.com"] },
  "washingtonpost.com": { selectors: ["[data-qa='regwall']", "#subscribe-wall"], loginHosts: ["subscribe.washingtonpost.com"] },
  "bloomberg.com": { selectors: ["#fortress-paywall-container-root"], loginHosts: [] },
  "hbr.org": { selectors: [".registration-wall", "[data-testid='paywall']"], loginHosts: [] },
};

const SOFT_PHRASES =
  /subscribe to (?:continue|read)|(?:reached|hit) your (?:free )?article limit|already a subscriber\??\s*log ?in|create a free account to continue|to continue reading/i;

const MIN_ARTICLE_CHARS = 600;

/** Config for a URL's host (matching subdomains), or null. */
export function siteFor(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const key = Object.keys(PAYWALL_SITES).find((d) => h === d || h.endsWith("." + d));
    return key ? { domain: key, ...PAYWALL_SITES[key] } : null;
  } catch (e) {
    return null;
  }
}

/**
 * Runs inside the page (puppeteer page.evaluate): collects the raw signals
 * detectPaywall() needs. Kept dependency-free so it serialises cleanly.
 */
export function collectSignals(selectors) {
  const ldFree = [];
  for (const s of document.querySelectorAll("script[type='application/ld+json']")) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        if ("isAccessibleForFree" in n) ldFree.push(String(n.isAccessibleForFree).toLowerCase());
        Object.values(n).forEach(walk);
      };
      walk(JSON.parse(s.textContent));
    } catch (e) {
      /* malformed JSON-LD is common; ignore */
    }
  }
  const paras = Array.from(document.querySelectorAll("article p, main p")).map((p) => p.innerText.trim()).filter(Boolean);
  const isArticle =
    !!document.querySelector("article, meta[property='og:type'][content='article']") ||
    ldFree.length > 0;
  return {
    ldFree,
    matchedSelectors: (selectors || []).filter((sel) => !!document.querySelector(sel)),
    bodyChars: paras.join("\n").length,
    paragraphs: paras.length,
    isArticle,
    text: ((document.body && document.body.innerText) || "").slice(0, 20000),
  };
}

/**
 * Classifies a page from collected signals.
 * @param {object} p
 * @param {string} p.url requested URL
 * @param {string} [p.finalUrl] URL after redirects
 * @param {number} [p.status] HTTP status of the main document
 * @param {object} [p.signals] result of collectSignals()
 * @returns {{paywalled: boolean, confidence: 'high'|'medium'|'none', reason: string}}
 */
export function detectPaywall({ url, finalUrl, status, signals }) {
  const site = siteFor(url) || siteFor(finalUrl || "");
  const s = signals || {};

  // Hard signals
  if (site && [401, 402, 403].includes(status)) {
    return { paywalled: true, confidence: "high", reason: `HTTP ${status} from ${site.domain}` };
  }
  if (site && finalUrl) {
    try {
      const fh = new URL(finalUrl).hostname.toLowerCase();
      const th = new URL(url).hostname.toLowerCase();
      if (fh !== th && site.loginHosts.includes(fh)) {
        return { paywalled: true, confidence: "high", reason: `redirected to login (${fh})` };
      }
    } catch (e) {
      /* ignore */
    }
  }
  if ((s.ldFree || []).includes("false")) {
    return { paywalled: true, confidence: "high", reason: "page marks content isAccessibleForFree=false" };
  }
  if ((s.matchedSelectors || []).length) {
    return { paywalled: true, confidence: "high", reason: `paywall element present (${s.matchedSelectors[0]})` };
  }

  // Soft signals: need two to agree
  const soft = [];
  if (s.isArticle && (s.bodyChars || 0) < MIN_ARTICLE_CHARS) soft.push("short article body");
  if (SOFT_PHRASES.test(s.text || "")) soft.push("subscribe/limit wording");
  if (soft.length >= 2) {
    return { paywalled: true, confidence: "medium", reason: soft.join(" + ") };
  }
  return { paywalled: false, confidence: "none", reason: "" };
}
