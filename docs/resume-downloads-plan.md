# Resumable course downloads — implementation plan

## Problem

Running a scrape is expensive (headless browsing, large media via `yt-dlp`,
rate-limited Canvas) and fragile (an expired cookie, a dropped connection, or a
`Ctrl-C` aborts it). Today a re-run does **not** pick up where it left off — it
starts over and, worse, **destroys the previous output first**:

```js
// core/scrape.js — scrapeCourse()
if (fs.existsSync(courseDir)) fs.rmSync(courseDir, { recursive: true, force: true });
fs.mkdirSync(courseDir, { recursive: true });
```

So the current model is *wipe-and-rebuild per course*, the opposite of resume.
On top of that, three lower-level behaviors make naive re-running unsafe even if
we stopped wiping:

1. **`mkUniqueDir` appends collision suffixes.** When a section/item folder
   already exists it creates `… (2)`, `… (3)` (`scrapers/helpers.js`), so a
   second run duplicates every folder instead of reusing it.
2. **Filenames are only known after fetching.** `downloadFile` derives the name
   from the response's `content-disposition` header, so "is this already on
   disk?" can't be answered from the URL alone before making the request.
3. **Writes are not atomic.** `streamToFile` pipes straight into the final path
   via `createWriteStream`. An interruption leaves a **truncated file at the
   real path** that looks complete on the next run.

We want it to be **safe to run the download any number of times**:

- A **complete** file already on disk is skipped (no re-fetch).
- A **missing or incomplete** file is (re-)downloaded and overwrites the stub.
- Content that **changed state** since the last run is reconciled correctly:
  assignments/modules that **lock or unlock**, items that gain a **grade**, and
  material that has been **archived/removed** — including under the `--wiki` and
  `--octarine` layouts, which physically relocate the output.

## Goals

- **Idempotent scrapes.** Re-running converges the output tree to the course's
  current state; a fully-downloaded course re-runs as (near) no-op.
- **Skip complete, replace incomplete/missing.** Decide per asset, cheaply,
  without re-downloading bytes that are already correctly on disk.
- **Survive interruption.** A killed run never leaves a truncated file that a
  later run mistakes for complete.
- **Handle state churn.** Lock/unlock transitions, grade changes, and
  archived/removed items don't cause duplicates or destroy still-valid files.
- **Work under every layout** — the default tree, `--wiki`, and `--octarine`.

## Non-goals

- Byte-range HTTP resume of a single interrupted file (re-fetch the whole file;
  Canvas file endpoints don't reliably support ranges). "Resume" here means
  *resume the run*, not *resume a socket*.
- Change detection by content hashing of remote assets we can't cheaply HEAD.
- Reworking what gets scraped or the scrapers themselves — only *how writes and
  re-runs are reconciled*.

## Key design decision: resume becomes the default

The whole point of the feature is that a plain re-run is safe, so **reconcile
in-place should be the default** and the destructive wipe becomes opt-in:

- `--fresh` (a.k.a. `--clean`) restores today's behavior: delete the course
  folder and re-download everything.
- Default (no flag) = reconcile against the existing tree + manifest.
- `--force` re-downloads matched items even when the manifest says complete
  (useful when the user suspects on-disk corruption) but still won't duplicate.

This mirrors the importer's "idempotent and reversible" stance in
`docs/importer-plan.md`. **Decided:** resume-in-place is the default and
`--fresh` is the escape hatch to today's wipe-and-rebuild behavior; everything
below builds on that.

## Approach: a persistent per-course manifest + reconcile-in-place

The scraper already builds an in-memory `report.rows` (`scrapers/report.js`)
mapping each saved file to its origin URL, but it's opt-in (`--report`) and
discarded at process exit. Resume needs the same information **persisted and
authoritative across runs**.

Introduce a **manifest**: one JSON file per course, written to a reserved path
that the wiki/octarine sweeps never touch:

```
<courseDir>/.scrape-manifest.json
```

Each entry is keyed by the asset's **stable source identity** (the Canvas URL,
normalized) and records where the bytes actually live and whether they're whole:

```jsonc
{
  "version": 1,
  "course_url": "https://<domain>/courses/38458",
  "updated": "2026-09-21T18:04:00Z",
  "assets": {
    "https://<domain>/files/91234/download": {
      "path": "ASSIGNMENTS/Week 1/Reading (A-).pdf",  // relative to courseDir
      "bytes": 184320,           // Content-Length at download time
      "etag": "\"a1b2…\"",       // if the server sent one
      "complete": true,
      "downloaded": "2026-09-14T…",
      "last_seen": "2026-09-21T…", // last run that still referenced this URL
      "state": "downloaded"        // downloaded | locked | removed | failed
    }
  }
}
```

`path` is stored **relative to `courseDir`** so it stays valid after `--wiki` /
`--octarine` relocate the tree (they update the manifest — see below).

### Download decision (skip complete / overwrite incomplete or missing)

Replace the unconditional write in `downloadFile` / `streamToFile` with a
reconcile step. Because the filename isn't known until the response arrives, the
cheapest correct order is:

1. Look up the URL in the manifest.
   - **Manifest says `complete` and the file exists** with a matching size
     (and matching ETag if we have one) → **skip**, refresh `last_seen`, no
     fetch. (With `--force`, fall through and re-download.)
2. Otherwise make the request. `HEAD` first when the endpoint supports it to get
   `Content-Length`/`ETag` without a body; fall back to `GET`.
   - If the manifest entry exists, the on-disk file exists, and
     `Content-Length` + `ETag` match → **skip the body**, mark complete.
   - Else **download to a temp file and atomically replace** (below), then
     record `{path, bytes, etag, complete:true}` in the manifest.

This gives "skip complete, overwrite incomplete/missing" with at most a cheap
HEAD for unchanged files, and a full re-download only when size/etag differ or
the file is absent/partial.

### Atomic writes (so "incomplete" is always detectable)

Change `streamToFile` to write to a sibling temp path and rename on success:

```js
const tmp = filePath + ".part";
// pipe response.body -> createWriteStream(tmp)
// on "finish": fs.renameSync(tmp, filePath)  // atomic on same filesystem
// on error / interrupt: leave/clean the .part; never a truncated final file
```

A leftover `*.part` (or a manifest entry with `complete:false`) is the signal
that the previous run died mid-file; the next run overwrites it. This is the
single most important change — without it, an interrupted large download is
indistinguishable from a good one. Apply the same pattern to `writeFile` (HTML
snapshots, comments, etc.).

### Stable directory & filenames (stop `mkUniqueDir` from duplicating)

`mkUniqueDir` must become **idempotent for the same logical item** instead of
always minting a new `… (n)` folder:

- Give each section/item a **stable identity** independent of volatile display
  text — prefer the Canvas id already in its URL (assignment id, module item id,
  file id) over the human name.
- When resuming, resolve an item to its **existing folder** by that identity
  (recorded in the manifest) rather than by string-matching the folder name.
- Keep the `… (n)` suffix only to disambiguate two *genuinely distinct* items
  that sanitize to the same name — never to sidestep an item's own prior folder.

**Grade-in-folder-name churn (concrete case).** The assignment scraper names its
folder `"<name> (<grade>)"` (`scrapers/assignments/index.js`). The grade changes
during the term, so the *same* assignment yields `Essay (–)` early and
`Essay (A-)` later — a path-identity resume would treat it as a new item and
duplicate the folder. Fix: key the folder on the assignment **id**, and when the
grade changes, **rename** the existing folder in place (and update the manifest)
rather than creating a second one. Same reasoning for any name that embeds
mutable state.

### Locked ↔ unlocked and archived/removed state transitions

The manifest's `last_seen` + `state` fields drive reconciliation each run:

- **Was missing/locked, now available** → download it (fills the gap). This is
  the normal "content unlocked as the course progressed" case.
- **Was downloaded, now locked/inaccessible** → **keep the existing file.**
  Locked ≠ gone; a 403/redirect/"locked" banner this run must not delete bytes
  we legitimately captured before. Mark `state:"locked"`, refresh `last_seen`,
  leave the file. (This is why we never re-wipe by default.)
- **Was downloaded, now genuinely removed** (no longer listed anywhere in the
  course this run, not merely locked) → mark `state:"removed"` and **retain the
  file by default**; only prune under an explicit `--prune` flag. Distinguishing
  "locked" from "removed" hinges on *how the item disappeared*: absent from the
  section listing entirely = candidate for removed; present-but-locked = locked.
- Detecting removed items requires knowing "everything referenced this run." The
  scrape already enumerates sections/items before downloading; record the set of
  URLs seen this run and diff it against the manifest's keys at the end.

### `--wiki` / `--octarine` layouts

`wiki.build` and `octarine.build` **`renameSync` whole category folders** into
`raw/…` and `.attachments/…` respectively. After a reorganized run the files are
no longer at their original scrape paths, so resume must track the *current*
location:

- Store the manifest at the reserved course-root path and **add it to the
  reserved/never-swept set** in both `wiki.js` (`RESERVED`) and `octarine.js`
  so the reorganizer doesn't move or index the manifest itself.
- When the reorganizer renames a folder, **rewrite the affected manifest
  `path`s** to the new location (a small post-move fixup keyed off the same
  moves it already performs).
- Resume then reconciles against wherever the manifest currently points, so a
  `--wiki`/`--octarine` output re-runs as a no-op just like the default tree.

### Videos (`yt-dlp`) idempotency

`downloadVideo` lets `yt-dlp` choose filenames and snapshots the directory
before/after. Lean on `yt-dlp`'s own resume rather than reinventing it:

- Add `--no-overwrites` and a per-course `--download-archive
  <courseDir>/.yt-dlp-archive.txt` so already-fetched videos/playlist entries
  are skipped on re-run and partial `.part`/`.ytdl` files resume.
- Fold the archive file into the reserved set (not swept by wiki/octarine).
- After the run, reconcile newly-present media into the manifest via the same
  before/after snapshot already in place.

## CLI surface

Additions to the existing scrape command (`index.js`), no new subcommand:

```
      --fresh          delete each course folder and re-download (today's behavior)
      --force          re-download matched assets even if the manifest says complete
      --prune          remove local files whose source is gone from the course
```

Default (none of the above) = resume/reconcile. `--dry-run` composes: it reports
what *would* be skipped / downloaded / pruned without writing.

## Module shape

- `scrapers/manifest.js` (new) — load/save/normalize the per-course manifest;
  `lookup(url)`, `record(url, {path, bytes, etag, state})`, `markSeen(url)`,
  `staleEntries()`, `relocate(oldPrefix, newPrefix)` (for wiki/octarine moves).
  Reuse `report`'s existing row shape where practical to avoid divergence.
- `scrapers/helpers.js` — `streamToFile`/`writeFile` gain the `.part`+rename
  atomic write; `downloadFile` gains the manifest skip/HEAD short-circuit;
  `mkUniqueDir` gains identity-aware reuse.
- `core/scrape.js` — `scrapeCourse` stops unconditionally wiping (guard behind
  `--fresh`), loads the manifest up front, records the "seen this run" URL set,
  and writes the manifest + runs stale-entry reconciliation at the end.
- `scrapers/wiki.js` / `scrapers/octarine.js` — reserve the manifest/archive
  files and rewrite manifest paths on move.

## Phases

1. **Atomic writes + stop wiping by default.** `.part`+rename in
   `streamToFile`/`writeFile`; put the `rmSync` behind `--fresh`. Immediately
   makes interrupted runs non-destructive even before the manifest lands.
2. **Manifest core.** `scrapers/manifest.js`; persist URL→path/size/complete;
   wire `downloadFile` to skip-complete / overwrite-incomplete; `--force`.
3. **Stable directories.** Identity-aware `mkUniqueDir`; grade-rename handling;
   kill duplicate `… (n)` folders on re-run.
4. **State reconciliation.** locked/unlocked/removed handling via
   `last_seen`/`state`; `--prune`.
5. **Layout integration.** wiki/octarine reserve + relocate the manifest;
   `yt-dlp` `--download-archive` / `--no-overwrites`.
6. **Dry-run + reporting.** `--dry-run` prints the skip/download/prune plan;
   surface counts in the run summary.

## Testing

- **Unit:** manifest load/save/normalize; skip decision (complete+size match →
  skip; size mismatch / missing / `complete:false` → re-download); atomic write
  leaves no truncated final file on simulated mid-stream error; `mkUniqueDir`
  reuses an existing folder for the same identity but still disambiguates two
  distinct items; grade change renames rather than duplicates; manifest
  `relocate` after a wiki/octarine move.
- **Integration:** scrape a fixture course into a temp dir; re-run and assert
  (a) no new bytes fetched, (b) no duplicate folders, (c) manifest unchanged
  except `last_seen`. Then: interrupt mid-file (leave a `.part`) → re-run
  completes just that file. Flip an item locked→unlocked and unlocked→locked →
  assert unlock downloads and lock keeps the existing file. Remove an item →
  default keeps it (`state:"removed"`), `--prune` deletes it. Repeat the whole
  suite under `--wiki` and `--octarine` to prove no-op re-runs and correct
  manifest relocation.

## Edge cases

- **Server sends no `Content-Length`/`ETag`.** Fall back to "file exists +
  manifest `complete:true`" → skip; otherwise re-download. Never trust an
  on-disk file with no manifest record as complete.
- **Same URL in multiple sections.** Manifest keys by URL+course (as `report`
  already dedupes); if it legitimately lands in two folders, store multiple
  paths for the one URL and verify each.
- **Cross-filesystem rename.** `.part` and final path are siblings in the same
  dir, so `rename` stays atomic; guard with a copy-then-unlink fallback for
  exotic mounts.
- **Manual imports.** The importer (`docs/importer-plan.md`) writes files the
  scraper didn't fetch; teach it to add a manifest entry (`state:"imported"`)
  so a later resume treats imported files as complete and never clobbers them.
- **Concurrent runs on one course.** Out of scope; a simple `.scrape-lock` in
  `courseDir` can fail fast if two runs collide.
