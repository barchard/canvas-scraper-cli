import React from "react";
import { render, Box, Text, useApp, useInput } from "ink";

import { runScrape } from "../core/scrape.js";
import { runLogin } from "../core/login.js";
import helpers from "../scrapers/helpers.js";

// Written with React.createElement (no JSX) so the app needs no build/transform
// step and stays friendly to the nexe binary packaging.
const h = React.createElement;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LOGS = 14; // how many recent log lines to keep on screen

/** Flattens a helpers.print record (and any attached error) into text lines. */
function recordToLines(rec) {
  const lines = [rec.line || `[${rec.type}] ${rec.name} | ${rec.message}`];
  if (rec.additional) {
    lines.push(String(rec.additional.message || rec.additional));
  }
  return lines;
}

function App({
  url,
  options,
  onFinish,
  run = runScrape,
  login = runLogin,
}) {
  const { exit } = useApp();
  const [logs, setLogs] = React.useState([]);
  const [status, setStatus] = React.useState({
    label: "Starting…",
    index: 0,
    total: 0,
    course: "",
    phase: "",
  });
  const [frame, setFrame] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [summary, setSummary] = React.useState(null);

  // With --login the run begins in an interactive "login" phase (capture cookies
  // in a browser window) before moving on to "scraping". Otherwise it starts
  // straight in "scraping" and behaves exactly as before.
  const [phase, setPhase] = React.useState(options.login ? "login" : "scraping");
  const [awaitingEnter, setAwaitingEnter] = React.useState(false);
  const enterResolver = React.useRef(null);
  const scrapeStarted = React.useRef(false);

  const appendLogs = React.useCallback((newLines) => {
    setLogs((prev) => [...prev, ...newLines].slice(-MAX_LOGS));
  }, []);

  // While the login flow is waiting, Enter (pressed here, not in the browser)
  // resolves the pending prompt and lets capture proceed.
  useInput(
    (input, key) => {
      if (!awaitingEnter) return;
      if (key.return) {
        setAwaitingEnter(false);
        const resolve = enterResolver.current;
        enterResolver.current = null;
        if (resolve) resolve();
      }
    },
    { isActive: awaitingEnter }
  );

  // Spinner animation.
  React.useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 90);
    return () => clearInterval(id);
  }, [done]);

  // Login phase: capture cookies interactively, then advance to scraping. The
  // login's helpers.print() output is routed into the log box (as runScrape
  // does for the scrape), and its "press Enter" prompt is satisfied by useInput
  // above instead of a terminal readline (which would fight Ink for stdin).
  React.useEffect(() => {
    if (phase !== "login") return undefined;
    let cancelled = false;

    const prevPrinter = helpers.printer;
    helpers.setPrinter((rec) => {
      if (!cancelled) appendLogs(recordToLines(rec));
    });

    const prompt = (msg) =>
      new Promise((resolve) => {
        if (cancelled) return resolve();
        appendLogs([msg]);
        enterResolver.current = resolve;
        setAwaitingEnter(true);
        return undefined;
      });

    login(url, {
      cookies: options.cookies,
      loginMode: options.loginMode,
      prompt,
    })
      .then(() => {
        if (cancelled) return;
        helpers.setPrinter(prevPrinter);
        setPhase("scraping");
      })
      .catch((e) => {
        if (cancelled) return;
        helpers.setPrinter(prevPrinter);
        setError(e.message || String(e));
        setDone(true);
      });

    return () => {
      cancelled = true;
      helpers.setPrinter(prevPrinter);
    };
  }, [phase]);

  // Scrape phase: kick off the scrape and wire progress/log callbacks into
  // component state. Guarded so it starts exactly once when the phase is
  // reached (whether that's at mount or after login).
  React.useEffect(() => {
    if (phase !== "scraping" || scrapeStarted.current) return undefined;
    scrapeStarted.current = true;
    let cancelled = false;
    const hooks = {
      onLog: (rec) => {
        if (cancelled) return;
        appendLogs(recordToLines(rec));
      },
      onProgress: (evt) => {
        if (cancelled) return;
        if (evt.type === "start") {
          setStatus((s) => ({
            ...s,
            total: evt.total,
            label: evt.mode === "single" ? "Scraping course" : "Scraping courses",
          }));
        } else if (evt.type === "course") {
          setStatus((s) => ({
            ...s,
            index: evt.index,
            total: evt.total,
            course: evt.name || evt.url,
            phase: "",
          }));
        } else if (evt.type === "phase") {
          setStatus((s) => ({ ...s, phase: evt.label }));
        }
      },
    };

    run(url, options, hooks)
      .then((sum) => {
        if (cancelled) return;
        setSummary(sum);
        setDone(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || String(e));
        setDone(true);
      });

    return () => {
      cancelled = true;
    };
  }, [phase]);

  // Let the final frame paint, then exit cleanly. The error (if any) is reported
  // through onFinish rather than exit() — passing an Error to Ink's exit() would
  // reject waitUntilExit() and dump a stack trace over the rendered UI.
  React.useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => {
      if (onFinish) onFinish(error || null);
      exit();
    }, 120);
    return () => clearTimeout(t);
  }, [done]);

  const header = h(
    Text,
    { color: "cyan", bold: true },
    "Canvas Scraper — Terminal UI"
  );

  const statusLine = done
    ? h(
        Text,
        { color: error ? "red" : "green", bold: true },
        error ? `✖ ${error}` : "✔ Done"
      )
    : phase === "login"
    ? h(
        Text,
        null,
        `${SPINNER[frame]} Logging in — finish signing in in the browser window`
      )
    : h(
        Text,
        null,
        `${SPINNER[frame]} ${status.label}` +
          (status.total ? ` (${status.index}/${status.total})` : "")
      );

  // During login, prompt the user to press Enter here once they've signed in.
  const promptLine =
    !done && awaitingEnter
      ? h(
          Text,
          { color: "cyan", bold: true },
          "→ Press Enter here once you're logged in (open Panopto too for videos)."
        )
      : null;

  const courseLine =
    !done && phase === "scraping" && status.course
      ? h(
          Text,
          { color: "yellow" },
          `Course: ${status.course}` + (status.phase ? ` — ${status.phase}` : "")
        )
      : null;

  const logBox = h(
    Box,
    {
      flexDirection: "column",
      marginTop: 1,
      borderStyle: "round",
      borderColor: "gray",
      paddingX: 1,
    },
    logs.length
      ? logs.map((line, i) =>
          h(Text, { key: i, dimColor: true, wrap: "truncate-end" }, line)
        )
      : h(Text, { dimColor: true }, "Waiting for output…")
  );

  const summaryBox =
    done && !error && summary
      ? h(
          Box,
          { flexDirection: "column", marginTop: 1 },
          h(Text, { color: "green" }, `Scraped ${summary.courseCount} course(s).`),
          h(Text, null, `Output: ${summary.outputDir}`)
        )
      : null;

  return h(
    Box,
    { flexDirection: "column" },
    header,
    h(Box, { marginTop: 1 }, statusLine),
    promptLine,
    courseLine,
    logBox,
    summaryBox
  );
}

/**
 * Renders the Ink terminal UI for a scrape and resolves when it exits.
 * @param {string} url the target Canvas URL
 * @param {object} options the resolved scrape options
 */
export async function renderTui(url, options) {
  let runError = null;
  const app = render(h(App, { url, options, onFinish: (e) => (runError = e) }));
  await app.waitUntilExit();
  if (runError) process.exitCode = 1;
}

export { App };
export default { renderTui, App };
