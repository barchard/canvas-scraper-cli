import fs from "fs";
import path from "path";

/**
 * Reorganizes a finished scrape into an Octarine workspace
 * (https://octarine.app) — a local-first Markdown note-taking / PKM app.
 *
 * Octarine conventions used here:
 *   - Media/attachments live in a `.attachments/` folder inside the workspace.
 *   - Notes are plain Markdown with YAML frontmatter ("Properties") at the top.
 *   - Notes link to each other and to attachments with doclinks (wikilinks):
 *     `[[Path/From/Workspace/Root]]`, using the full path relative to the
 *     workspace root when the target is inside a folder.
 *   - Tags are `#tag` / `#nested/tag`.
 *
 * The scraper drops every downloaded file into `.attachments/` and generates a
 * Markdown note per course (linking that course's assets) plus a top-level
 * `Index.md` that links the course notes:
 *
 *   <workspace>/
 *     .attachments/            every scraped file, grouped by course/type
 *     Courses/<Course>.md      one note per course — frontmatter, tags, doclinks
 *     Index.md                 links every course note
 */

// Category folders the scrapers produce, in display order. Mirrors wiki.js.
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

/**
 * Builds the Octarine workspace inside `dir`, moving the scraped output into
 * `.attachments/` and generating the course notes and index.
 * @param {string} dir the scrape output directory (becomes the workspace)
 * @param {Array<object>} [rows] report rows, used to enrich notes with each
 *   course's URL (matched by name). Safe to omit.
 * @returns {{sources: number, notes: number, bytes: number}} counts to log
 */
function build(dir, rows = []) {
  const attachDir = path.join(dir, ".attachments");
  fs.mkdirSync(attachDir, { recursive: true });

  // Names the workspace layout owns — never swept into .attachments/.
  const reserved = new Set([
    ".attachments",
    "Courses",
    "Index.md",
    "report.csv",
    "report-skipped.csv",
    ".DS_Store",
  ]);

  // Sweep every non-reserved top-level entry into .attachments/. On a fresh
  // scrape these are the course folders (or, in single-course mode, the
  // category folders and HOMEPAGE.pdf directly).
  for (const name of fs.readdirSync(dir)) {
    if (reserved.has(name)) continue;
    fs.renameSync(path.join(dir, name), path.join(attachDir, name));
  }

  // In single-course mode the files land directly under .attachments/ with no
  // course folder; recover the course's real name/URL from the report rows.
  const singleCourse = rows.find((r) => r.courseName)?.courseName || "Course";

  // Map basename -> source URL for best-effort "source" links.
  const urlByFile = new Map();
  for (const r of rows) {
    if (r.file && r.originalUrl && !urlByFile.has(r.file)) {
      urlByFile.set(r.file, r.originalUrl);
    }
  }

  const files = listFilesRecursive(attachDir);
  let totalBytes = 0;

  // Group into course -> category -> [entries].
  const courses = new Map();
  for (const full of files) {
    const rel = path.relative(attachDir, full);
    const segments = rel.split(path.sep);
    let { course, category } = classify(segments);
    if (course === "Course") course = singleCourse;

    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch (e) {
      // File vanished between listing and stat — skip it.
    }
    totalBytes += size;

    const entry = {
      name: path.basename(full),
      // Doclink target: full path from the workspace root, forward slashes.
      link: [".attachments", ...rel.split(path.sep)].join("/"),
      type: path.extname(full).replace(/^\./, "").toLowerCase() || "file",
      sizeHuman: humanSize(size),
      source: urlByFile.get(path.basename(full)) || "",
    };

    if (!courses.has(course)) courses.set(course, new Map());
    const cats = courses.get(course);
    if (!cats.has(category)) cats.set(category, []);
    cats.get(category).push(entry);
  }

  // URL per course (best effort): a row whose courseName is part of the folder.
  const urlByCourse = new Map();
  for (const r of rows) {
    if (r.courseName && r.courseUrl && !urlByCourse.has(r.courseName)) {
      urlByCourse.set(r.courseName, r.courseUrl);
    }
  }

  fs.mkdirSync(path.join(dir, "Courses"), { recursive: true });
  const courseNames = [...courses.keys()].sort((a, b) => a.localeCompare(b));
  for (const course of courseNames) {
    writeCourseNote(dir, course, courses.get(course), courseUrlFor(course, urlByCourse));
  }
  writeIndex(dir, courses, files.length, totalBytes);

  return { sources: files.length, notes: courseNames.length, bytes: totalBytes };
}

/** Finds a course URL by matching a report courseName against the folder name. */
function courseUrlFor(course, urlByCourse) {
  if (urlByCourse.has(course)) return urlByCourse.get(course);
  for (const [name, url] of urlByCourse) {
    if (name && course.includes(name)) return url;
  }
  return "";
}

/** Writes one course note: frontmatter, a tag, and its assets as doclinks. */
function writeCourseNote(dir, course, cats, url) {
  const count = [...cats.values()].reduce((n, arr) => n + arr.length, 0);
  const out = [];
  out.push("---");
  out.push(`title: ${yamlString(course)}`);
  out.push("type: course");
  out.push("tags: [course]");
  out.push(`sources: ${count}`);
  if (url) out.push(`url: ${url}`);
  out.push("---");
  out.push("");
  out.push("#course");
  out.push("");

  const orderedCats = [...cats.keys()].sort(
    (a, b) => catRank(a) - catRank(b) || a.localeCompare(b)
  );
  for (const cat of orderedCats) {
    out.push(`## ${CATEGORY_LABEL[cat] || cat}`);
    out.push("");
    const entries = cats.get(cat).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const meta = [e.type, e.sizeHuman].filter(Boolean).join(", ");
      const source = e.source ? ` · [source](${e.source})` : "";
      out.push(`- [[${e.link}]] — ${meta}${source}`);
    }
    out.push("");
  }

  fs.writeFileSync(path.join(dir, "Courses", `${course}.md`), out.join("\n"));
}

/** Writes Index.md: a note linking every course note. */
function writeIndex(dir, courses, count, bytes) {
  const out = [];
  out.push("---");
  out.push("title: Index");
  out.push("type: index");
  out.push("tags: [index]");
  out.push("---");
  out.push("");
  out.push("#index");
  out.push("");
  out.push(
    "Canvas scrape organized as an [Octarine](https://octarine.app) workspace. Downloaded files live in `.attachments/`; each course note below links its own assets."
  );
  out.push("");
  out.push(`- Generated: ${new Date().toISOString()}`);
  out.push(`- Sources: ${count} (${humanSize(bytes)})`);
  out.push("");
  out.push("## Courses");
  out.push("");
  const courseNames = [...courses.keys()].sort((a, b) => a.localeCompare(b));
  for (const course of courseNames) {
    const n = [...courses.get(course).values()].reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    out.push(`- [[Courses/${course}]] — ${n} source(s)`);
  }
  out.push("");
  fs.writeFileSync(path.join(dir, "Index.md"), out.join("\n"));
}

/**
 * Determines the course and category buckets for a file, given its path
 * segments relative to .attachments/. Mirrors wiki.js.
 * @param {string[]} segments
 * @returns {{course: string, category: string}}
 */
function classify(segments) {
  if (segments.length === 1 || KNOWN_CATEGORIES.has(segments[0])) {
    return { course: "Course", category: categoryOf(segments) };
  }
  return { course: segments[0], category: categoryOf(segments.slice(1)) };
}

/** Picks a category bucket from path segments below the course level. */
function categoryOf(segments) {
  if (segments.length <= 1) return "overview";
  return KNOWN_CATEGORIES.has(segments[0]) ? segments[0] : "other";
}

/** Rank for ordering categories; unknown categories sort last (before "other"). */
function catRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length - 1 : i;
}

/** Quotes a YAML scalar when it could otherwise be misparsed. */
function yamlString(s) {
  return /^[\w .()&+-]+$/.test(s) ? s : JSON.stringify(s);
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
