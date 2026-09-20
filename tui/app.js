import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import React from "react";
import { render, Box, Text, useApp, useInput } from "ink";

import { runScrape, parseTarget, readCookies } from "../core/scrape.js";
import { runLogin } from "../core/login.js";
import { launchBrowser } from "../core/browser.js";
import helpers from "../scrapers/helpers.js";

// Written with React.createElement (no JSX) so the app needs no build/transform
// step and stays friendly to the nexe binary packaging.
const h = React.createElement;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LOGS = 14; // how many recent log lines to keep on screen
const LIST_WINDOW = 12; // how many list items to show at once

const URL_RE = /^https:\/\/[^/]+(\/courses\/[^/]+)?\/?$/;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Collects the lines shown by the "About" menu action: app version, Node/OS
 * details, and the current git commit. Each lookup is best-effort — a packaged
 * binary has no package.json or git checkout, so those simply read "unknown".
 */
function getAboutInfo() {
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
    );
    version = pkg.version || version;
  } catch {
    /* no package.json (e.g. packaged binary) */
  }

  let sha = "unknown";
  try {
    sha = execSync("git rev-parse HEAD", {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    /* not a git checkout */
  }
  const shortSha = sha === "unknown" ? sha : sha.slice(0, 7);

  return [
    `Canvas Scraper CLI v${version}`,
    `Commit: ${shortSha}${sha !== "unknown" ? ` (${sha})` : ""}`,
    `Node: ${process.version}`,
    `Platform: ${process.platform} ${process.arch}`,
    `OS: ${os.type()} ${os.release()}`,
  ];
}

/** Formats a byte count as a short human-readable string (e.g. "1.4 GB"). */
function fmtBytes(n) {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Formats a seconds count as m:ss (e.g. 92 -> "1:32"). */
function fmtEta(s) {
  if (s == null) return "";
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

/** Renders a text progress bar of the given width; empty if percent unknown. */
function progressBar(percent, width = 20) {
  if (percent == null) return "";
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Renders a two-line progress block for one download or transcription event.
 * Downloads show bytes/speed/ETA; transcriptions show elapsed time (and a
 * percentage bar when the transcriber reports one, else "transcribing…").
 */
function progressBlock(p) {
  const isTranscribe = p.scope === "transcribe";
  const icon = isTranscribe ? "📝" : p.scope === "video" ? "🎬" : "⬇";
  const seq =
    p.count && p.count > 1 ? ` [${p.index || "?"}/${p.count}]` : "";
  const bar = progressBar(p.percent);
  const pct = p.percent != null ? `${Math.floor(p.percent)}%` : "";

  let meta;
  if (isTranscribe) {
    meta = p.elapsed != null ? fmtEta(p.elapsed) : "";
  } else {
    const size = p.total
      ? `${fmtBytes(p.received)}/${fmtBytes(p.total)}`
      : p.received != null
      ? fmtBytes(p.received)
      : "";
    const speed = p.speed ? `${fmtBytes(p.speed)}/s` : "";
    const eta = p.eta != null ? `ETA ${fmtEta(p.eta)}` : "";
    meta = [size, speed, eta].filter(Boolean).join("  ");
  }

  const idleLabel = isTranscribe ? "transcribing…" : "downloading…";
  return h(
    Box,
    { flexDirection: "column" },
    h(
      Text,
      { color: isTranscribe ? "cyan" : "magenta", wrap: "truncate-end" },
      `${icon}${seq} ${p.name || ""}`
    ),
    h(
      Text,
      null,
      bar ? h(Text, { color: "green" }, bar) : h(Text, { dimColor: true }, idleLabel),
      h(Text, null, pct ? `  ${pct}` : ""),
      meta ? h(Text, { dimColor: true }, `  ${meta}`) : null
    )
  );
}

/** Flattens a helpers.print record (and any attached error) into text lines. */
function recordToLines(rec) {
  const lines = [rec.line || `[${rec.type}] ${rec.name} | ${rec.message}`];
  if (rec.additional) {
    lines.push(String(rec.additional.message || rec.additional));
  }
  return lines;
}

// ── Reusable keyboard-driven prompts (built on useInput; no extra deps) ──────

/** Single-line text input. Enter submits (after optional validate). */
function TextPrompt({ message, initialValue = "", validate, onSubmit }) {
  const [value, setValue] = React.useState(initialValue);
  const [err, setErr] = React.useState(null);

  useInput((input, key) => {
    if (key.return) {
      const v = value.trim();
      if (validate) {
        const r = validate(v);
        if (r !== true) {
          setErr(typeof r === "string" ? r : "Invalid input.");
          return;
        }
      }
      onSubmit(v);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((s) => s.slice(0, -1));
      setErr(null);
      return;
    }
    // Ignore control/navigation keys; append everything else.
    if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow ||
        key.downArrow || key.leftArrow || key.rightArrow) {
      return;
    }
    if (input) {
      setValue((s) => s + input);
      setErr(null);
    }
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Text,
      null,
      h(Text, { color: "green" }, "? "),
      h(Text, { bold: true }, `${message} `),
      h(Text, { color: "cyan" }, value),
      h(Text, { inverse: true }, " ")
    ),
    err ? h(Text, { color: "red" }, err) : null
  );
}

/** Windowed slice of a list around the cursor, with scroll hints. */
function windowed(items, idx) {
  if (items.length <= LIST_WINDOW) return { start: 0, visible: items };
  let start = Math.min(
    Math.max(0, idx - Math.floor(LIST_WINDOW / 2)),
    items.length - LIST_WINDOW
  );
  if (start < 0) start = 0;
  return { start, visible: items.slice(start, start + LIST_WINDOW) };
}

/** Single-select list. Up/Down to move, Enter to choose. */
function SelectPrompt({ message, items, onSelect }) {
  const [idx, setIdx] = React.useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) onSelect(items[idx].value, items[idx]);
  });

  const { start, visible } = windowed(items, idx);
  return h(
    Box,
    { flexDirection: "column" },
    h(
      Text,
      null,
      h(Text, { color: "green" }, "? "),
      h(Text, { bold: true }, message),
      h(Text, { dimColor: true }, "  (↑/↓, Enter)")
    ),
    start > 0 ? h(Text, { dimColor: true }, "  ▲ more") : null,
    ...visible.map((it, i) => {
      const absolute = start + i;
      const active = absolute === idx;
      return h(
        Text,
        { key: absolute, color: active ? "cyan" : undefined },
        `${active ? "❯ " : "  "}${it.label}`
      );
    }),
    start + visible.length < items.length
      ? h(Text, { dimColor: true }, "  ▼ more")
      : null
  );
}

/** Multi-select checklist. Up/Down to move, Space to toggle, Enter to submit. */
function MultiSelectPrompt({ message, items, onSubmit }) {
  const [idx, setIdx] = React.useState(0);
  const [checked, setChecked] = React.useState(
    () => new Set(items.filter((i) => i.checked).map((i) => i.value))
  );

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (input === " ") {
      setChecked((prev) => {
        const next = new Set(prev);
        const v = items[idx].value;
        if (next.has(v)) next.delete(v);
        else next.add(v);
        return next;
      });
    } else if (key.return) {
      onSubmit(items.filter((it) => checked.has(it.value)).map((it) => it.value));
    }
  });

  const { start, visible } = windowed(items, idx);
  return h(
    Box,
    { flexDirection: "column" },
    h(
      Text,
      null,
      h(Text, { color: "green" }, "? "),
      h(Text, { bold: true }, message),
      h(Text, { dimColor: true }, "  (↑/↓, Space, Enter)")
    ),
    start > 0 ? h(Text, { dimColor: true }, "  ▲ more") : null,
    ...visible.map((it, i) => {
      const absolute = start + i;
      const active = absolute === idx;
      const box = checked.has(it.value) ? "◉" : "◯";
      return h(
        Text,
        { key: absolute, color: active ? "cyan" : undefined },
        `${active ? "❯ " : "  "}${box} ${it.label}`
      );
    }),
    start + visible.length < items.length
      ? h(Text, { dimColor: true }, "  ▼ more")
      : null
  );
}

// ── The unified app: wizard steps → login → scrape, all in one Ink render ────

function App({ url, options = {}, onFinish, run = runScrape, login = runLogin }) {
  const { exit } = useApp();

  // Everything the run needs is collected here. In flag/--tui mode it's seeded
  // from the CLI options; in wizard mode the steps fill it in.
  const configRef = React.useRef(
    url
      ? {
          ...options,
          url,
          loginMode: options.loginMode || "fresh",
          // Interactive when opened for the action menu (`<url>` / `--tui <url>`
          // with no content flags); flag-driven runs skip straight to scraping.
          _menu: !!options._menu,
          _domain: parseTarget(url).domain,
          _courseId: parseTarget(url).courseId,
        }
      : {
          url: "",
          output: "courses",
          cookies: "cookies.json",
          loginMode: "fresh",
          a: false, m: false, q: false, v: false, s: false,
          t: false, report: false, wiki: false, octarine: false,
          all: false, tui: false,
          _menu: true,
          _domain: "",
          _courseId: null,
        }
  );

  // Step machine. Wizard mode (no url) asks for the URL first, then everything
  // funnels through the action menu. Flag-driven runs jump straight to login or
  // scraping.
  const firstStep = url
    ? options._menu
      ? "menu"
      : options.login
      ? "login"
      : "scraping"
    : "url";
  const [step, setStep] = React.useState(firstStep);

  const [logs, setLogs] = React.useState([]);
  const [courses, setCourses] = React.useState([]);
  const [download, setDownload] = React.useState(null);
  const [transcribe, setTranscribe] = React.useState(null);
  const [status, setStatus] = React.useState({
    label: "Starting…", index: 0, total: 0, course: "", phase: "",
  });
  const [frame, setFrame] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [summary, setSummary] = React.useState(null);
  const [awaitingEnter, setAwaitingEnter] = React.useState(false);

  const enterResolver = React.useRef(null);
  const loginStarted = React.useRef(false);
  const scrapeStarted = React.useRef(false);

  const appendLogs = React.useCallback((newLines) => {
    setLogs((prev) => [...prev, ...newLines].slice(-MAX_LOGS));
  }, []);

  const fail = React.useCallback((e) => {
    setError(e && e.message ? e.message : String(e));
    setDone(true);
  }, []);

  // Enter during login satisfies the "press Enter once you're signed in" prompt.
  useInput(
    (input, key) => {
      if (awaitingEnter && key.return) {
        setAwaitingEnter(false);
        const resolve = enterResolver.current;
        enterResolver.current = null;
        if (resolve) resolve();
      }
    },
    { isActive: step === "login" && awaitingEnter }
  );

  // Enter on the About screen returns to the action menu.
  useInput(
    (input, key) => {
      if (key.return) setStep("menu");
    },
    { isActive: step === "about" }
  );

  // Spinner animation (only while something is running).
  React.useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 90);
    return () => clearInterval(id);
  }, [done]);

  // Login phase: capture cookies interactively, then advance (to the next
  // wizard step, or straight to scraping in flag/--tui mode).
  React.useEffect(() => {
    if (step !== "login" || loginStarted.current) return undefined;
    loginStarted.current = true;
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

    login(configRef.current.url, {
      cookies: configRef.current.cookies,
      loginMode: configRef.current.loginMode,
      prompt,
    })
      .then(() => {
        if (cancelled) return;
        helpers.setPrinter(prevPrinter);
        // Allow logging in again later (the menu can re-enter this step).
        loginStarted.current = false;
        setStep(configRef.current._menu ? "menu" : "scraping");
      })
      .catch((e) => {
        if (cancelled) return;
        helpers.setPrinter(prevPrinter);
        loginStarted.current = false;
        fail(e);
      });

    return () => {
      cancelled = true;
      helpers.setPrinter(prevPrinter);
    };
  }, [step]);

  // Course-fetch phase: list the user's courses so they can pick one.
  React.useEffect(() => {
    if (step !== "fetchCourses") return undefined;
    let cancelled = false;

    (async () => {
      let cookies;
      try {
        cookies = readCookies(configRef.current.cookies);
      } catch (e) {
        appendLogs([`[WARNING] COURSES | Could not read cookies: ${e.message}`]);
        appendLogs([
          "[NOTE] COURSES | Tip: run the Log in action first to capture cookies.",
        ]);
        if (!cancelled) setStep("types"); // fall back to all courses
        return;
      }
      appendLogs(["[NOTE] COURSES | Fetching your courses…"]);
      const domain = configRef.current._domain;
      let found = [];
      try {
        // Try the cookie-authed REST API first (no browser needed); only spin
        // up Chrome for the HTML fallback if the API returns nothing.
        found = await helpers.listCourses(domain, cookies);
        if (!found.length) {
          let browser;
          try {
            browser = await launchBrowser();
            found = await helpers.listCourses(domain, cookies, browser);
          } finally {
            if (browser) await browser.close().catch(() => {});
          }
        }
      } catch (e) {
        appendLogs([`[WARNING] COURSES | Could not list courses: ${e.message}`]);
      }
      if (cancelled) return;
      if (!found.length) {
        appendLogs([
          "[WARNING] COURSES | No courses found — falling back to all courses.",
        ]);
        setStep("types");
        return;
      }
      setCourses(found);
      setStep("course");
    })();

    return () => {
      cancelled = true;
    };
  }, [step]);

  // Scrape phase: run the scrape and stream progress/log into state.
  React.useEffect(() => {
    if (step !== "scraping" || scrapeStarted.current) return undefined;
    scrapeStarted.current = true;
    let cancelled = false;

    const hooks = {
      onLog: (rec) => {
        if (!cancelled) appendLogs(recordToLines(rec));
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
            index: evt.index, total: evt.total,
            course: evt.name || evt.url, phase: "",
          }));
          setDownload(null);
          setTranscribe(null);
        } else if (evt.type === "phase") {
          setStatus((s) => ({ ...s, phase: evt.label }));
          setDownload(null);
          setTranscribe(null);
        } else if (evt.type === "download") {
          // Download and transcription run concurrently, so each gets its own
          // slot. Videos keep their last frame between playlist items; files and
          // finished transcriptions clear so they don't linger stale.
          if (evt.scope === "transcribe") {
            setTranscribe(evt.phase === "done" ? null : evt);
          } else if (evt.phase === "done" && evt.scope === "file") {
            setDownload(null);
          } else {
            setDownload(evt);
          }
        }
      },
    };

    run(configRef.current.url, configRef.current, hooks)
      .then((sum) => {
        if (cancelled) return;
        setSummary(sum);
        setDone(true);
      })
      .catch((e) => {
        if (cancelled) return;
        fail(e);
      });

    return () => {
      cancelled = true;
    };
  }, [step]);

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

  // ── Wizard step handlers ───────────────────────────────────────────────────

  const onUrl = (value) => {
    const cfg = configRef.current;
    cfg.url = value;
    const { domain, courseId } = parseTarget(value);
    cfg._domain = domain;
    cfg._courseId = courseId;
    setStep("menu");
  };

  const onMenu = (value) => {
    const cfg = configRef.current;
    if (value === "scrape") {
      // Browse the courses first (unless the URL already names one), then ask
      // what to download.
      setStep(cfg._courseId ? "types" : "scope");
    } else if (value === "login") {
      loginStarted.current = false;
      setStep("cookiesPathLogin");
    } else if (value === "about") {
      setStep("about");
    } else if (value === "changeUrl") {
      setStep("url");
    } else if (value === "exit") {
      setDone(true);
    }
  };

  const onCookiesPathLogin = (value) => {
    configRef.current.cookies = value || "cookies.json";
    loginStarted.current = false;
    setStep("login");
  };

  const onScope = (value) => {
    setStep(value === "one" ? "fetchCourses" : "types");
  };

  const onCourse = (id) => {
    configRef.current.url = `${configRef.current._domain}/courses/${id}`;
    setStep("types");
  };

  const onTypes = (values) => {
    const cfg = configRef.current;
    cfg.a = values.includes("a");
    cfg.m = values.includes("m");
    cfg.q = values.includes("q");
    cfg.v = values.includes("v");
    cfg.s = values.includes("s");
    setStep("output");
  };

  const onOutput = (value) => {
    configRef.current.output = value || "courses";
    setStep("extras");
  };

  const onExtras = (values) => {
    const cfg = configRef.current;
    cfg.report = values.includes("report");
    cfg.wiki = values.includes("wiki");
    cfg.octarine = values.includes("octarine");
    cfg.t = values.includes("t");
    setStep("scraping");
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const header = h(Text, { color: "cyan", bold: true }, "Canvas Scraper — Terminal UI");

  const spin = (label) => h(Text, null, `${SPINNER[frame]} ${label}`);

  let view = null;
  if (done) {
    view = h(
      Text,
      { color: error ? "red" : "green", bold: true },
      error ? `✖ ${error}` : "✔ Done"
    );
  } else if (step === "url") {
    view = h(TextPrompt, {
      message: "Canvas URL (https://<school_domain> or a course URL):",
      validate: (v) =>
        URL_RE.test(v) ||
        "Use https://<school_domain> or https://<school_domain>/courses/<id>.",
      onSubmit: onUrl,
    });
  } else if (step === "menu") {
    view = h(SelectPrompt, {
      message: `What would you like to do? (${configRef.current.url})`,
      items: [
        { label: "Scrape / download from courses", value: "scrape" },
        { label: "Log in (opens a browser to capture cookies)", value: "login" },
        { label: "About (version, system & git info)", value: "about" },
        { label: "Change Canvas URL", value: "changeUrl" },
        { label: "Exit", value: "exit" },
      ],
      onSelect: onMenu,
    });
  } else if (step === "about") {
    view = h(
      Box,
      { flexDirection: "column" },
      ...getAboutInfo().map((line, i) => h(Text, { key: i }, line)),
      h(
        Box,
        { marginTop: 1 },
        h(Text, { color: "cyan" }, "Press Enter to return to the menu.")
      )
    );
  } else if (step === "cookiesPathLogin") {
    view = h(TextPrompt, {
      message: "Where should the captured cookies be saved?",
      initialValue: configRef.current.cookies || "cookies.json",
      onSubmit: onCookiesPathLogin,
    });
  } else if (step === "types") {
    view = h(MultiSelectPrompt, {
      message: "What do you want to scrape?",
      items: [
        { label: "Assignments", value: "a", checked: true },
        { label: "Modules", value: "m", checked: true },
        { label: "Quizzes", value: "q", checked: true },
        { label: "Videos (Panopto)", value: "v", checked: true },
        { label: "Study.Net Materials", value: "s", checked: true },
      ],
      onSubmit: onTypes,
    });
  } else if (step === "scope") {
    view = h(SelectPrompt, {
      message: "Scrape all your courses, or pick one?",
      items: [
        { label: "Pick a specific course", value: "one" },
        { label: "All my courses", value: "all" },
      ],
      onSelect: onScope,
    });
  } else if (step === "fetchCourses") {
    view = spin("Fetching your courses…");
  } else if (step === "course") {
    view = h(SelectPrompt, {
      message: `Which course? (${courses.length} found)`,
      items: courses.map((c) => ({ label: `${c.name} (${c.id})`, value: c.id })),
      onSelect: onCourse,
    });
  } else if (step === "output") {
    view = h(TextPrompt, {
      message: "Output directory:",
      initialValue: configRef.current.output || "courses",
      onSubmit: onOutput,
    });
  } else if (step === "extras") {
    view = h(MultiSelectPrompt, {
      message: "Any extras? (optional)",
      items: [
        { label: "CSV report of downloaded assets (--report)", value: "report" },
        { label: "Organize as an LLM Wiki (--wiki)", value: "wiki" },
        { label: "Organize as an Octarine workspace (--octarine)", value: "octarine" },
        { label: "Transcribe downloaded videos (-t)", value: "t" },
      ],
      onSubmit: onExtras,
    });
  } else if (step === "login") {
    view = spin("Logging in — finish signing in in the browser window");
  } else if (step === "scraping") {
    view = spin(
      `${status.label}` + (status.total ? ` (${status.index}/${status.total})` : "")
    );
  }

  const promptLine =
    !done && step === "login" && awaitingEnter
      ? h(
          Text,
          { color: "cyan", bold: true },
          "→ Press Enter here once you're logged in (open Panopto too for videos)."
        )
      : null;

  const courseLine =
    !done && step === "scraping" && status.course
      ? h(
          Text,
          { color: "yellow" },
          `Course: ${status.course}` + (status.phase ? ` — ${status.phase}` : "")
        )
      : null;

  // Live download and transcription progress (they run concurrently, so each
  // shows on its own line). Otherwise the big Panopto/video jobs are a single
  // opaque line.
  const showProgress = !done && step === "scraping";
  const downloadLines = showProgress && download ? progressBlock(download) : null;
  const transcribeLines = showProgress && transcribe ? progressBlock(transcribe) : null;

  const showLogs =
    done || ["login", "fetchCourses", "scraping"].includes(step);
  const logBox = showLogs
    ? h(
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
      )
    : null;

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
    h(Box, { marginTop: 1 }, view),
    promptLine,
    courseLine,
    downloadLines,
    transcribeLines,
    logBox,
    summaryBox
  );
}

/**
 * Renders the unified Ink terminal UI and resolves when it exits.
 *
 * @param {string} [url] the target Canvas URL. Omit it to run the interactive
 *   wizard: it asks for the URL, then opens the action menu (Log in / About /
 *   Scrape …). The Scrape action browses the courses first, then asks what to
 *   download. Pass `options._menu` to open that same menu for a given URL.
 * @param {object} [options] resolved scrape options (used when `url` is given).
 */
export async function renderTui(url, options = {}) {
  let runError = null;
  const app = render(
    h(App, { url, options, onFinish: (e) => (runError = e) })
  );
  await app.waitUntilExit();
  if (runError) process.exitCode = 1;
}

export { App };
export default { renderTui, App };
