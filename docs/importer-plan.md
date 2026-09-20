# Manual content importer — implementation plan

## Problem

Some course material can't be pulled automatically but is trivially obtainable
by hand. The clearest case is Harvard Business Publishing readings reached
through a Canvas LTI launch
(`…/external_tools/retrieve?url=…hbsp.harvard.edu…`): the signed launch opens
fine in a real browser (the user confirmed these links work when clicked), but
the headless POST that fetches the PDF can fail. When that happens the item
lands in `report-skipped.csv` and — now — in `download-diagnostics.jsonl`, but
there is no supported way to take the file the user downloaded by hand and slot
it back into the scraped corpus at the right place.

The importer closes that loop: **the user drops in a manually-obtained file, and
the tool files it exactly where the scraper would have put it**, so the output
tree (and the `--wiki` / `--octarine` layouts and `report.csv`) is complete.

## Goals

- Map a manually-supplied file to the correct **course → content type →
  section → item** location, matching the scraper's own directory layout.
- Drive the mapping off artifacts the scraper already produces
  (`report-skipped.csv`, `download-diagnostics.jsonl`) so the user works from a
  concrete worklist of gaps rather than guessing paths.
- Keep imports **idempotent and reversible** — re-running doesn't duplicate, and
  an imported file is distinguishable from a scraped one.
- Fold imported files into `report.csv` and the wiki/octarine indexes so
  downstream tooling treats them as first-class assets.

## Non-goals

- Automating the download itself (that's the scraper's job; the diagnostics
  feature exists to make those cases fixable in the scraper over time).
- Any new browser automation. The importer is a pure filesystem + manifest tool.

## Prerequisite: record the destination on every failure

Today `report.recordFailure(url, reason)` and `report.recordDiagnostic(entry)`
capture the source URL and course, but **not the destination folder** the file
would have gone into. `searchAndDownloadExternal(page, cookies, dir, …)` knows
that folder (`dir` is the section directory, e.g.
`<course>/ASSIGNMENTS/<section>`), and the item name is known one level up in
`scrapeSections`. Without it, the importer can only place files at course level.

**Change:** thread the destination through to the failure record. Add
`destDir` and `item` to the failure/diagnostic rows:

- In `helpers.searchAndDownloadExternal`, pass `dir` (and, where available, the
  item/link name) into the `recordFailure` / `downloadLtiPdf` calls, and include
  them on the recorded row.
- Add `dest_dir` and `item` columns to `report-skipped.csv`
  (`report.writeSkipped`) and the corresponding fields to the diagnostics
  entries.

This is a small, self-contained change and is what lets the importer place files
precisely instead of into a catch-all folder. It should land first.

## Approach: worklist-driven import with a manifest

Two layers:

1. **Worklist** — the set of gaps to fill, read from `report-skipped.csv`
   (and/or `download-diagnostics.jsonl`) in the output directory. Each row is a
   `{url, reason, course_name, course_url, dest_dir, item}` gap.
2. **Manifest** — a small user-editable file (`import/manifest.csv` or
   `import/manifest.json`) mapping a **dropped file** to a **worklist key**. The
   key is the original Canvas `url` (stable, already in every report), so the
   user only has to answer "which link is this file for?".

Default flow: the user runs the importer, it prints the outstanding worklist,
they drop files into `import/` and either (a) let the importer match by an
interactive prompt per file, or (b) fill in the manifest and re-run
non-interactively.

### Manifest format (CSV)

```
file,url
15.716 Session 5 - Pre-work - H03PQF.pdf,https://canvas.mit.edu/courses/38458/external_tools/retrieve?url=…H03PQF-PDF-ENG…
```

- `file` — path relative to `import/`.
- `url` — the worklist key (the Canvas link from the skipped/diagnostics report).
  Matching is exact on the full URL, with a fallback to matching the decoded
  `url=` target's resource id (e.g. `H03PQF-PDF-ENG`) so a lightly-edited URL
  still resolves.

JSON is accepted too (same fields) for programmatic generation.

## Placement

For a matched row, compute the destination the scraper would have used:

- If `dest_dir` is present on the row → copy the file there, sanitized via
  `helpers.stripInvalid`, preferring the manifest's `file` basename (or the
  `item` name) for a human-readable filename.
- If `dest_dir` is absent (rows written before the prerequisite change) → fall
  back to `<output>/<course_name>/IMPORTED/` and warn that precise placement
  needs a re-scrape to capture `dest_dir`.

Every imported file is recorded via `report.record(filePath, url)` so it flows
into `report.csv`, and a marker (see below) is written next to it.

### Idempotency & provenance

- Maintain `<output>/import/imported.log.jsonl` — one line per import
  (`{time, url, file, dest}`) — as the source of truth for what's already in.
- Before copying, skip rows whose `url` already appears in the log **and** whose
  destination file still exists. This makes re-runs safe.
- Write a sidecar `<file>.imported.json` (or an entry in a per-folder
  `.imported.json`) alongside each imported file so a scrape/import round-trip
  can tell imported assets from scraped ones and reconcile the wiki index.

## CLI surface

A new `import` subcommand in `index.js` (peer of the existing `login`
subcommand), plus a `core/import.js` module (peer of `core/scrape.js`):

```
canvas-scraper import [output]
  -o, --output <dir>      output directory to import into (default: courses)
      --from <path>       worklist source (default: <output>/report-skipped.csv;
                          also accepts download-diagnostics.jsonl)
      --manifest <path>   manifest file (default: <output>/import/manifest.csv)
      --dir <path>        folder holding the dropped files (default: <output>/import)
      --interactive       prompt to match each unmapped dropped file to a gap
      --dry-run           show what would be imported without copying
```

`import` with no manifest and `--interactive` lists the worklist, lists the
files in `import/`, and walks the user through matching them (reusing
`inquirer`, already a dependency). Non-interactive `import` consumes the
manifest and is CI/script friendly.

## Module shape (`core/import.js`)

- `readWorklist(output, fromPath)` → array of gap rows (parse the skipped CSV /
  diagnostics JSONL; dedupe by `url`).
- `readManifest(path)` → `[{file, url}]` (CSV or JSON).
- `resolve(worklist, manifest, dropDir)` → `[{row, srcFile, dest, status}]`
  where status is `ready | missing-file | unmatched-url | already-imported`.
- `apply(resolved, {dryRun})` → copies files, calls `report.record`, appends to
  `imported.log.jsonl`, writes sidecars; returns a summary.
- `runImport(output, options)` → orchestrates the above and prints a summary in
  the same `helpers.print` style as the scraper.

Reuse `helpers.stripInvalid` for filenames and `report` for CSV I/O so the
importer stays consistent with the rest of the tool.

## User workflow

1. Scrape as normal. HBSP (and other) gaps land in `report-skipped.csv` /
   `download-diagnostics.jsonl`.
2. `canvas-scraper import --interactive` prints the outstanding gaps.
3. The user opens the Canvas links (which work by hand), saves the PDFs into
   `import/`, and answers the match prompts (or edits `import/manifest.csv`).
4. The importer copies each file to the scraper's own location, updates
   `report.csv`, and logs the import.
5. Re-running is a no-op for already-imported items; new drops are picked up.

## Edge cases

- **Same URL referenced from several sections** — the scraper dedupes failures
  per `url+course`, so a gap maps to one `dest_dir`; if the item legitimately
  belongs in multiple folders, the manifest can list the file twice against the
  same `url` and the importer copies to each recorded destination.
- **Wrong file for a link** — no content validation is possible; rely on the
  human match. Record the mapping in the log so it's auditable/reversible.
- **Filename collisions** — reuse the scraper's `mkUnique`/`stripInvalid`
  conventions so an import never clobbers a scraped file.
- **Stale rows (pre-`dest_dir`)** — handled by the `IMPORTED/` fallback + a
  warning to re-scrape once for precise placement.
- **`--wiki` / `--octarine` outputs** — after import, regenerate the affected
  index (or document that the user re-runs the wiki/octarine organizer) so
  imported files appear in `index.md` and are cited like scraped sources.

## Phases

1. **Prerequisite:** add `dest_dir` + `item` to failure/diagnostic records and
   to `report-skipped.csv`. (Small, unblocks precise placement.)
2. **Core import (non-interactive):** `core/import.js` + `import` subcommand
   consuming a manifest; copy, log, record, sidecars, idempotency.
3. **Interactive matching:** `--interactive` worklist walkthrough.
4. **Index reconciliation:** fold imports into `--wiki` / `--octarine` outputs.

## Testing

- Unit: worklist parsing (CSV + JSONL), manifest parsing, URL/resource-id
  matching, destination computation, idempotency (re-run is a no-op).
- Integration: a fixture output dir with a `report-skipped.csv`, a fake HBSP
  gap, a dropped PDF, and a manifest → assert the file lands at the computed
  `dest_dir`, `report.csv` gains a row, and `imported.log.jsonl` records it;
  re-run copies nothing.
