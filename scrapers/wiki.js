import fs from "fs";
import path from "path";

/**
 * Reorganizes a finished scrape into the "LLM Wiki" layout popularized by
 * Andrej Karpathy (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
 *
 * The pattern separates immutable source material from LLM-generated synthesis:
 *
 *   <output>/
 *     raw/        every scraped file — immutable, the LLM only reads these
 *     wiki/       LLM-generated synthesis pages — scaffolded empty here
 *     index.md    catalog of everything under raw/, grouped by course/category
 *     log.md      append-only record of ingests
 *     CLAUDE.md   schema: how the wiki is laid out and how to maintain it
 *
 * This scraper has no LLM of its own, so it fills the `raw/`, `index.md`,
 * `log.md`, and `CLAUDE.md` layers and leaves `wiki/` as an empty scaffold for
 * an agent (Claude Code, Codex, ...) to build out afterward.
 */

// Top-level names the wiki layout owns — never swept into raw/.
const RESERVED = new Set([
  "raw",
  "wiki",
  "index.md",
  "log.md",
  "CLAUDE.md",
  "report.csv",
  "report-skipped.csv",
]);

// Category folders the scrapers produce, in the order they should appear in the
// index. Anything else falls under "other"; a course-root file is "overview".
const CATEGORY_ORDER = [
  "overview",
  "assignments",
  "modules",
  "quizzes",
  "videos",
  "studynet",
  "other",
];
const CATEGORY_LABEL = {
  overview: "Overview",
  assignments: "Assignments",
  modules: "Modules",
  quizzes: "Quizzes",
  videos: "Videos",
  studynet: "Study.Net Materials",
  other: "Other",
};
const KNOWN_CATEGORIES = new Set([
  "assignments",
  "modules",
  "quizzes",
  "videos",
  "studynet",
]);

const GIST_URL =
  "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f";

/**
 * Builds the LLM Wiki layout inside `dir`, moving the scraped output into
 * `raw/` and generating the catalog, log, schema, and `wiki/` scaffold.
 * @param {string} dir the scrape output directory
 * @param {Array<object>} [rows] report rows, used to enrich entries with source
 *   URLs (matched by file basename). Safe to omit.
 * @returns {{sources: number, bytes: number}} counts for the caller to log
 */
function build(dir, rows = []) {
  const rawDir = path.join(dir, "raw");
  fs.mkdirSync(rawDir, { recursive: true });

  // Sweep every non-reserved top-level entry into raw/. On a fresh scrape these
  // are the course folders (or, in single-course mode, the category folders and
  // HOMEPAGE.pdf directly).
  for (const name of fs.readdirSync(dir)) {
    if (RESERVED.has(name)) continue;
    fs.renameSync(path.join(dir, name), path.join(rawDir, name));
  }

  // Map basename -> source URL for best-effort "source" links in the index.
  const urlByFile = new Map();
  for (const r of rows) {
    if (r.file && r.originalUrl && !urlByFile.has(r.file)) {
      urlByFile.set(r.file, r.originalUrl);
    }
  }

  const files = listFilesRecursive(rawDir);
  let totalBytes = 0;

  // Group into course -> category -> [entries].
  const courses = new Map();
  for (const full of files) {
    const rel = path.relative(rawDir, full);
    const segments = rel.split(path.sep);
    const { course, category } = classify(segments);

    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch (e) {
      // File vanished between listing and stat — skip it.
    }
    totalBytes += size;

    const entry = {
      name: path.basename(full),
      href: path
        .join("raw", rel)
        .split(path.sep)
        .map(encodeURIComponent)
        .join("/"),
      type: path.extname(full).replace(/^\./, "").toLowerCase() || "file",
      sizeHuman: humanSize(size),
      source: urlByFile.get(path.basename(full)) || "",
    };

    if (!courses.has(course)) courses.set(course, new Map());
    const cats = courses.get(course);
    if (!cats.has(category)) cats.set(category, []);
    cats.get(category).push(entry);
  }

  writeIndex(dir, courses, files.length, totalBytes);
  writeLog(dir, files.length, totalBytes);
  writeSchema(dir);
  scaffoldWiki(dir);

  return { sources: files.length, bytes: totalBytes };
}

/**
 * Determines the course and category buckets for a file, given its path
 * segments relative to raw/.
 * @param {string[]} segments
 * @returns {{course: string, category: string}}
 */
function classify(segments) {
  // Single-course scrape: raw/ holds category folders / HOMEPAGE.pdf directly.
  if (segments.length === 1 || KNOWN_CATEGORIES.has(segments[0])) {
    return { course: "Course", category: categoryOf(segments) };
  }
  // Multi-course scrape: raw/<course>/<category>/...
  return {
    course: segments[0],
    category: categoryOf(segments.slice(1)),
  };
}

/** Picks a category bucket from path segments below the course level. */
function categoryOf(segments) {
  if (segments.length <= 1) return "overview"; // course-root file (e.g. HOMEPAGE.pdf)
  return KNOWN_CATEGORIES.has(segments[0]) ? segments[0] : "other";
}

/** Writes index.md: the catalog of every raw source, grouped and linked. */
function writeIndex(dir, courses, count, bytes) {
  const out = [];
  out.push("# Course Wiki — Index");
  out.push("");
  out.push(
    `> Catalog of raw source material, generated by canvas-scraper-cli following the [LLM Wiki pattern](${GIST_URL}).`
  );
  out.push(
    "> Files under `raw/` are immutable — read them, never edit them. Synthesis pages belong in `wiki/`. See `CLAUDE.md`."
  );
  out.push("");
  out.push(`- Generated: ${new Date().toISOString()}`);
  out.push(`- Sources: ${count} (${humanSize(bytes)})`);
  out.push("");

  const courseNames = [...courses.keys()].sort((a, b) => a.localeCompare(b));
  for (const course of courseNames) {
    out.push(`## ${course}`);
    out.push("");
    const cats = courses.get(course);
    const orderedCats = [...cats.keys()].sort(
      (a, b) => catRank(a) - catRank(b) || a.localeCompare(b)
    );
    for (const cat of orderedCats) {
      out.push(`### ${CATEGORY_LABEL[cat] || cat}`);
      out.push("");
      const entries = cats
        .get(cat)
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const meta = [e.type, e.sizeHuman].filter(Boolean).join(", ");
        const source = e.source ? ` · [source](${e.source})` : "";
        out.push(`- [${e.name}](${e.href}) — ${meta}${source}`);
      }
      out.push("");
    }
  }

  fs.writeFileSync(path.join(dir, "index.md"), out.join("\n"));
}

/** Rank for ordering categories; unknown categories sort last (before "other"). */
function catRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length - 1 : i;
}

/** Appends an ingest line to log.md (creating it with a header if needed). */
function writeLog(dir, count, bytes) {
  const logPath = path.join(dir, "log.md");
  const line = `- ${new Date().toISOString()} — ingest: ${count} raw source(s) (${humanSize(
    bytes
  )}) scraped by canvas-scraper-cli\n`;
  if (fs.existsSync(logPath)) {
    fs.appendFileSync(logPath, line);
  } else {
    fs.writeFileSync(logPath, `# Log\n\nAppend-only record of ingests.\n\n${line}`);
  }
}

/** Writes CLAUDE.md — the schema doc telling an agent how to use this vault. */
function writeSchema(dir) {
  const schema = `# LLM Wiki — Schema

This directory is an [LLM Wiki](${GIST_URL}): a knowledge base an LLM agent
builds and maintains from source material, instead of re-deriving answers from
raw documents on every query.

## Layout

- \`raw/\` — immutable source material scraped from Canvas, grouped by course and
  content type (assignments, modules, quizzes, videos, Study.Net). **Never edit
  or delete these.** They are the ground truth.
- \`wiki/\` — synthesis you (the LLM) own entirely: summaries, entity pages,
  concept pages, comparisons, an overview. Create and link these freely.
- \`index.md\` — a catalog of everything under \`raw/\`, with a link and metadata
  per file. Regenerated on each scrape.
- \`log.md\` — an append-only record of what happened and when.

## Conventions

- Wiki pages are markdown, one topic per file, interlinked with relative links.
- Every claim in a wiki page should cite the \`raw/\` file(s) it came from.
- When \`raw/\` changes, reconcile the affected wiki pages and note it in \`log.md\`.

## Workflow

1. Read \`index.md\` to see what raw material exists.
2. Read the relevant \`raw/\` files.
3. Write or update pages in \`wiki/\`, citing sources.
4. Append a line to \`log.md\`.
`;
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), schema);
}

/** Creates the empty wiki/ layer with a README explaining who owns it. */
function scaffoldWiki(dir) {
  const wikiDir = path.join(dir, "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });
  const readme = `# Wiki

LLM-generated synthesis lives here — summaries, entity pages, concept pages,
comparisons, an overview. This layer is owned by the LLM agent; \`raw/\` is the
immutable source material it draws from. See \`../CLAUDE.md\` for conventions.

This folder starts empty. Point an LLM agent at this directory to build it out.
`;
  fs.writeFileSync(path.join(wikiDir, "README.md"), readme);
}

/** Formats a byte count as B/KB/MB/GB/TB with two decimals above bytes. */
function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(2)} ${units[i]}`;
}

/** Lists every file under `dir` recursively, returning full paths. */
function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export default { build };
