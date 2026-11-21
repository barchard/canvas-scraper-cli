/**
 * Bot-wall detection for external pages.
 *
 * Some sites (Cloudflare/DataDome-protected sites, news publishers such as
 * The Economist) refuse automated browsers outright and serve an interstitial
 * ("Access is temporarily restricted", "Are you a robot?", "Just a moment...")
 * or an empty page instead of the content. The scraper never tries to get past
 * these: it detects them so the page is reported, not archived as junk, and the
 * user can save it from their own browser and add it with `canvas-scraper import`.
 *
 * Unlike a paywall, a bot wall is not fixed by cookies — the site rejects the
 * automated browser itself — so the guidance differs.
 */

// Passive "protected by reCAPTCHA/hCaptcha" notices that many legitimate sites
// embed on newsletter/comment forms (e.g a site footer). Not a challenge.
const PASSIVE_CAPTCHA = /protected by (?:google )?(?:re)?captcha|protected by hcaptcha/g;

const INTERSTITIAL =
  /are you a robot|just a moment|access (?:to this page has been )?denied|access is (?:temporarily )?restricted|enable javascript|please enable (?:js|cookies)|verify you are (?:a )?human|captcha|unusual (?:traffic|activity)|automated \(?bot\)? activity|request (?:was )?blocked/;

/** Below this many characters a page is treated as empty (nothing rendered). */
export const EMPTY_PAGE_CHARS = 200;
/** An interstitial keyword only counts on a page shorter than this. */
export const SHORT_PAGE_CHARS = 1000;

/**
 * Classifies a rendered page as blocked by bot protection.
 * @param {object} p
 * @param {string} [p.title] page title
 * @param {string} [p.text] visible body text
 * @returns {{blocked: boolean, kind: 'empty'|'interstitial'|'', match: string}}
 */
export function detectBotWall({ title = "", text = "" } = {}) {
  const len = String(text).trim().length;
  if (len < EMPTY_PAGE_CHARS) return { blocked: true, kind: "empty", match: "" };
  if (len >= SHORT_PAGE_CHARS) return { blocked: false, kind: "", match: "" };
  // A real bot wall is a short interstitial; a full article that mentions one
  // of these phrases in passing (e.g a reading *about* CAPTCHAs) is not blocked.
  const probe = `${title}\n${text}`.toLowerCase().replace(PASSIVE_CAPTCHA, "");
  const m = probe.match(INTERSTITIAL);
  return m ? { blocked: true, kind: "interstitial", match: m[0] } : { blocked: false, kind: "", match: "" };
}

/** The URL's host without a leading "www.", or "" if unparseable. */
export function siteHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

/**
 * The console/CSV reason for a bot-walled page.
 * @param {string} url the page URL
 * @param {{kind: string, match: string}} wall detectBotWall() result
 * @returns {string}
 */
export function botWallReason(url, wall) {
  const host = siteHost(url) || "the site";
  const what =
    wall.kind === "interstitial"
      ? `${host} blocked the automated browser ("${wall.match}")`
      : `${host} rendered an empty page (likely blocking the automated browser)`;
  return (
    `bot-blocked: ${what} — saved cookies don't help here; open it in your own ` +
    "browser, save it as a PDF, and add it with `canvas-scraper import`"
  );
}

export default { detectBotWall, botWallReason, siteHost, EMPTY_PAGE_CHARS, SHORT_PAGE_CHARS };
