import React from "react";
import { render, Box, Text, useApp } from "ink";

import { runScrape } from "../core/scrape.js";

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

function App({ url, options, onFinish, run = runScrape }) {
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

  // Spinner animation.
  React.useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 90);
    return () => clearInterval(id);
  }, [done]);

  // Kick off the scrape and wire progress/log callbacks into component state.
  React.useEffect(() => {
    let cancelled = false;
    const hooks = {
      onLog: (rec) => {
        if (cancelled) return;
        setLogs((prev) => [...prev, ...recordToLines(rec)].slice(-MAX_LOGS));
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
  }, []);

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
    : h(
        Text,
        null,
        `${SPINNER[frame]} ${status.label}` +
          (status.total ? ` (${status.index}/${status.total})` : "")
      );

  const courseLine =
    !done && status.course
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
