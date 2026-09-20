import fs from "fs";
import os from "os";
import { execFileSync } from "child_process";

/**
 * Chrome / Chromium detection and install guidance.
 *
 * The standalone executables (built with nexe) do NOT bundle Chromium, so the
 * app relies on a Google Chrome (or Chromium) already installed on the machine.
 * This module locates that browser and, when it's missing, prints friendly
 * download links plus Scoop (Windows) / Homebrew (macOS) install instructions.
 */

/** Known Chrome/Chromium install locations per platform. */
function candidatePaths() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    const dirs = [
      process.env["PROGRAMFILES"],
      process.env["PROGRAMFILES(X86)"],
      process.env["LOCALAPPDATA"],
    ].filter(Boolean);
    const paths = [];
    for (const dir of dirs) {
      paths.push(`${dir}\\Google\\Chrome\\Application\\chrome.exe`);
      paths.push(`${dir}\\Chromium\\Application\\chrome.exe`);
    }
    return paths;
  }
  // linux and everything else
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

/** Looks up a browser executable on PATH via `where` (Windows) or `which`. */
function fromPath() {
  const names =
    process.platform === "win32"
      ? ["chrome", "chrome.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const finder = process.platform === "win32" ? "where" : "which";
  for (const name of names) {
    try {
      const out = execFileSync(finder, [name], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .split(/\r?\n/)[0]
        .trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* not on PATH; try the next name */
    }
  }
  return null;
}

/**
 * Returns the path to an installed Google Chrome / Chromium, or null if none
 * is found. Honors the same env overrides Puppeteer respects so power users can
 * point at a custom build.
 *
 * @returns {string|null}
 */
export function findChrome() {
  const override =
    process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return override;

  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore and keep looking */
    }
  }

  return fromPath();
}

/**
 * Human-readable install instructions for the current platform: a direct
 * download link plus a package-manager one-liner (Scoop on Windows, Homebrew
 * on macOS, the distro note on Linux).
 *
 * @returns {string}
 */
export function chromeInstallInstructions() {
  const download = "  Download Chrome directly: https://www.google.com/chrome/";

  if (process.platform === "win32") {
    return [
      "Google Chrome was not found on this system.",
      "",
      download,
      "",
      "  Or install it with Scoop (https://scoop.sh):",
      "    scoop bucket add extras",
      "    scoop install extras/googlechrome",
      "",
      "  (Winget also works: winget install Google.Chrome)",
    ].join("\n");
  }

  if (process.platform === "darwin") {
    return [
      "Google Chrome was not found on this system.",
      "",
      download,
      "",
      "  Or install it with Homebrew (https://brew.sh):",
      "    brew install --cask google-chrome",
    ].join("\n");
  }

  return [
    "Google Chrome / Chromium was not found on this system.",
    "",
    download,
    "",
    "  Or install Chromium with your package manager, e.g.:",
    "    sudo apt install chromium        # Debian/Ubuntu",
    "    sudo dnf install chromium        # Fedora",
    "    sudo snap install chromium       # Snap",
  ].join("\n");
}

/**
 * Preflight guard: verifies Chrome is available before the app tries to launch
 * it. When missing, prints download + install instructions and exits with a
 * non-zero code so the user gets actionable guidance instead of a raw
 * Puppeteer launch stack trace.
 *
 * @returns {string} the resolved Chrome executable path (when found)
 */
export function ensureChrome() {
  const chrome = findChrome();
  if (chrome) return chrome;

  console.error("");
  console.error(chromeInstallInstructions());
  console.error("");
  console.error("After installing Chrome, run this command again.");
  process.exit(1);
}

export default { findChrome, chromeInstallInstructions, ensureChrome };
