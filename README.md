# Canvas Scraper CLI

A NodeJS command-line interface for scraping and downloading data (e.g. assignments and modules) from a Canvas course.

## Dependencies

Canvas-Scraper uses [Puppeteer](https://pptr.dev/), a headless browser, to navigate and scrape data from Canvas. This requires some form of [Chromium](https://www.chromium.org/chromium-projects/) to be available on the system. The easiest way to do this is by installing [Google Chrome](https://www.google.com/chrome/).

To download embedded videos (saved as `mp4`), Canvas-Scraper shells out to [yt-dlp](https://github.com/yt-dlp/yt-dlp), which must be installed and available on your `PATH` (e.g. `brew install yt-dlp` on macOS). It handles [YouTube](https://www.youtube.com/) and [Panopto](https://www.panopto.com/) links. If `yt-dlp` is not installed, video links are skipped (with a warning) and the rest of the scrape continues normally.

For **YouTube** links, recent `yt-dlp` versions need a JavaScript runtime — without one you'll see "No supported JavaScript runtime could be found" and some formats may be missing or fail. Install [Deno](https://deno.com/) and `yt-dlp` will pick it up automatically: `brew install deno` (macOS) or `scoop install deno` (Windows). See the [yt-dlp EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS) for details.

**Windows path length:** course/module folders can nest deeply; the scraper passes `yt-dlp` an absolute output path so it can use Windows extended-length paths and avoid the 260-char `MAX_PATH` limit. If you still hit `unable to open for writing … No such file or directory`, either [enable Win32 long paths](https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation) (`LongPathsEnabled`) or use a short output directory near the drive root, e.g. `-o D:\c`.

Panopto videos are often behind a login. So that `yt-dlp` can authenticate, the scraper converts your cookies file into a cookie file it passes to `yt-dlp`. For login-gated Panopto sites (e.g. `*.hosted.panopto.com`), make sure your cookies file also includes the cookies for the Panopto domain (export them the same way you export your Canvas cookies, while signed into Panopto).

A link to a Panopto **folder** (e.g. `…/Pages/Sessions/List.aspx?folderID=…`) is downloaded as a playlist — every session in it is saved as `mp4` into a subfolder named after the folder. A link to a single **session** (`Viewer.aspx`/`Embed.aspx?id=…`) downloads just that one video.

To send other providers through `yt-dlp`, add their hostnames to the `videoHosts` array in `config.json` (it accepts anything [yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), e.g. `"vimeo.com"`). Subdomains match automatically, so `panopto.com` already covers `*.hosted.panopto.com`. Any external link not matched by a video host is downloaded directly as a file.

## Getting Started

You'll first need to get the cookies for your current Canvas session to allow the scraper to have credentials to your Canvas. This needs to be done in JSON format (an example can be found in cookies-example.json).

The easiest way to do this is by logging into Canvas in your browser and using an extension to export your current cookies (e.g. [CookieManager](https://chromewebstore.google.com/detail/cookiemanager-cookie-edit/hdhngoamekjhmnpenphenpaiindoinpo) for Chrome).

### Cookies for Panopto (and other login-gated videos)

Panopto support is built in — `panopto.com` and its subdomains (e.g. `*.hosted.panopto.com`) are already recognized, so you **do not** need to change `config.json` to download Panopto videos.

There is **no separate Panopto cookies file**. The scraper uses one cookies file for everything: it authenticates Canvas with it and also converts it into the cookie file it hands to `yt-dlp`. To download login-gated Panopto videos, that same file must also contain your Panopto session cookies:

1. In the same browser, open and sign in to your Panopto site (e.g. `https://<your-org>.hosted.panopto.com`).
2. Using CookieManager (or your cookie-export extension), export the cookies for the Panopto domain.
3. Open your cookies file — it is a single JSON array of cookie objects (see `cookies-example.json`). Append the exported Panopto cookie objects to that same array, alongside your Canvas cookies, and save.

**Name and location:** Panopto has no special filename or path — reuse the cookies file you already pass to the scraper. By default that is `cookies.json` in the directory you run the scraper from; if you pass `-c <path>` (or set it in the wizard), put the Panopto cookies in that file. Canvas and Panopto entries simply live side by side in the same array, for example:

```json
[
  { "name": "canvas_session", "value": "…", "domain": ".instructure.com", "path": "/", "secure": true },
  { "name": ".ASPXAUTH",      "value": "…", "domain": "your-org.hosted.panopto.com", "path": "/", "secure": true }
]
```

If the Panopto cookies are missing or expired, those video downloads are skipped with a warning and the rest of the scrape continues.

### Using Pre-Compiled Release

First, download the latest version from the [Releases](https://github.com/xxmistacruzxx/canvas-scraper/releases) page and extract the ZIP file. Inside the folder, you'll find three (3) different executables, with each being for a different operating system.

To use the executable, you can either open it using your file explorer (which will open a wizard to guide you through the different arguments and flags) or simply navigate to the directory in a shell and call the executable.

e.g Windows<br/>
`./canvas-scraper.exe [options] <url>`

### Using Source Code

You will need [NodeJS](https://nodejs.org/en) and [NPM](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).

Once installed, download the project dependencies using...

`npm i`

After, you can simply run the entry file directly...

`node index.js [options] <url>`

## Usage

```
Usage: canvas-scraper [options] <url>

Scrape data from a canvas course

Arguments:
  url                      Course URL (https://<school_domain>/courses/<course_id>), or a bare https://<school_domain> to scrape all your courses

Options:
  -o, --output <dir_name>  output directory name (default: "courses/course")
  -c, --cookies <path>     path to cookies file (default: "cookies.json")
  -a                       scrape assignments (default: false)
  -m                       scrape modules (default: false)
  -q                       scrape quizzes (default: false)
  -v                       scrape the Videos (Panopto) page (default: false)
  -s                       scrape the Study.Net Materials page (default: false)
  -t                       transcribe downloaded videos via config.json transcribeCommand (default: false)
  --report                 write a report.csv listing every downloaded asset (default: false)
  --wiki                    organize output into the Karpathy LLM Wiki layout (raw/, wiki/, index.md) (default: false)
  --octarine                organize output into an Octarine workspace (.attachments/, course notes, Index.md) (default: false)
  -h, --help               display help for command
```

Use any combination of the `a`, `m`, `q`, `v`, and `s` flags to choose what to scrape. If none are provided, all of them are scraped. (`-t`, `--report`, `--wiki`, and `--octarine` are separate modifiers — they are **not** included in "scrape all".)

### Asset report (`--report`)

Add `--report` to write a `report.csv` into the output directory listing **every asset the scraper downloaded** — Canvas files, external documents, archived web pages, Panopto/YouTube videos, Harvard Business Publishing PDFs, and Study.Net materials. Each row has:

| Column | Description |
| --- | --- |
| `file` | the saved filename |
| `type` | the file's extension (e.g. `pdf`, `mp4`, `docx`) |
| `size_bytes` | the exact size in bytes |
| `size` | the same size, human-readable (`KB`, `MB`, `GB`, … as appropriate) |
| `course_name` | the course the asset came from |
| `course_url` | that course's Canvas URL |
| `original_url` | where the asset was downloaded from |

When scraping all your courses, every course's assets are listed together in one `report.csv` at the top of the output directory. Generated page snapshots (the `HOMEPAGE.pdf` / `MODULE.pdf` / `QUIZ.pdf` course-navigation PDFs) are **not** included — the report covers downloaded assets, not the tool's own page captures.

Alongside it, a second file — `report-skipped.csv` — lists every asset that was **skipped or failed to download** (view-only Study.Net materials, Panopto folders/sessions `yt-dlp` couldn't fetch, external-tool launches with no downloadable file, links that returned an error page, etc.):

| Column | Description |
| --- | --- |
| `url` | the asset's source URL |
| `reason` | why it was skipped or failed |
| `course_name` | the course the asset belonged to |
| `course_url` | that course's Canvas URL |

`report-skipped.csv` is only written when there is at least one skipped/failed download.

### LLM Wiki layout (`--wiki`)

Add `--wiki` to reorganize the output into the [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) popularized by Andrej Karpathy — a layout that separates immutable source material from LLM-generated synthesis, so you can point an agent (Claude Code, Codex, …) at the folder and have it build a knowledge base instead of re-reading every file on each query:

```
<output>/
  raw/        every scraped file, grouped by course/content type — immutable sources
  wiki/       LLM-generated synthesis pages (scaffolded empty, the agent owns this)
  index.md    a catalog of everything under raw/, linked and grouped by course/category
  log.md      an append-only record of each ingest
  CLAUDE.md   the schema: how the vault is laid out and how an agent should maintain it
```

The scraper fills the `raw/`, `index.md`, `log.md`, and `CLAUDE.md` layers and leaves `wiki/` empty for an agent to build out. `index.md` links each source with its type, size, and (where known) the URL it came from — `--wiki` turns the asset recorder on for those source links, so you don't also need `--report`. Combine `--wiki` with the content flags as usual (e.g. `--all --wiki`).

### Octarine workspace (`--octarine`)

Add `--octarine` to organize the output as an [Octarine](https://octarine.app) workspace — Octarine is a local-first Markdown note-taking / personal-knowledge app, so the scrape becomes a set of notes you can open directly:

```
<output>/                    (the Octarine workspace)
  .attachments/              every scraped file, grouped by course/content type
  Courses/<Course>.md        one note per course — YAML properties, a #course tag,
                             and a doclink to each of that course's assets
  Index.md                   a note that doclinks every course note
```

Following Octarine's conventions, downloaded files are kept in the workspace's `.attachments/` folder, notes carry YAML frontmatter ("Properties") and `#tags`, and everything is cross-linked with doclinks (`[[Courses/<Course>]]`, `[[.attachments/<Course>/…/file.pdf]]`) using the full path from the workspace root. Each asset doclink is annotated with its type, size, and (where known) source URL — like `--wiki`, this flag turns the asset recorder on for those links, so you don't also need `--report`. Point Octarine at the output directory to open it as a workspace.

`--wiki` and `--octarine` are two alternative ways to lay out the same files; if you pass both, `--wiki` wins and `--octarine` is skipped.

### Scraping all your courses

Pass a bare domain (no `/courses/<id>`) to scrape **every course you're enrolled in**:

```
node index.js -o courses https://<school_domain>
```

The scraper queries the Canvas API (`/api/v1/courses`, using your cookies) for all your courses — current **and** past/completed enrollments — and scrapes each one into its own subfolder of the output directory, named `<Course Name> (<id>)`. (Courses you can no longer open, e.g. those date-restricted after a term ends, are skipped.) If your institution blocks cookie-authenticated API access, it automatically falls back to scraping the `/courses` page instead. The same flags apply to every course; a course that fails (e.g. an inaccessible homepage) is logged and skipped without stopping the rest. Give a full course URL to scrape just that one course (output goes straight into the output directory, as before).

The `-v` flag archives the course's **Videos** tab (the Panopto course folder): it launches the Panopto LTI tab while signed in, finds the folder it lands on, and downloads every session as `mp4` via `yt-dlp` into `VIDEOS/`. This requires your Panopto cookies in the cookies file (see [Cookies for Panopto](#cookies-for-panopto-and-other-login-gated-videos)). The nav tab is matched by the label `Videos` by default; if your course names it differently, set `"videosTabLabel"` in `config.json`.

The `-s` flag archives the course's **Study.Net Materials** tab into `STUDYNET/`. Study.Net is a third-party course-pack tool reached through a signed Canvas LTI launch: the scraper opens the tab while signed in, which performs the launch and renders the materials list, then downloads each material (the per-user watermarked PDF / spreadsheet) into `STUDYNET/`. Files are saved **in the instructor's order** with a zero-padded numeric prefix (`01 - <name>.pdf`, `02 - …`) so they sort correctly on disk instead of alphabetically; the numbering matches the list you see in the tab. Website links the instructor included in the list are saved in place as `.url` shortcuts (e.g. `03 - <name> (LINK).url`), keeping the reading list complete and contiguous. Because the launch itself establishes the Study.Net session in the browser, your **Canvas** cookies are normally sufficient — you do **not** need to add Study.Net cookies to the cookies file. (You can still add a `www.study.net` `PHPSESSID` cookie as a fallback; note that a Study.Net session is short-lived — roughly a day.) The nav tab is matched by the label `Study.Net Materials` by default; if your course names it differently, set `"studyNetTabLabel"` in `config.json`. Anything the tool refuses to hand over (view-only content) is skipped with a warning that points you to the tab so you can open it manually.

### Transcribing videos

The `-t` flag runs a transcription command on each downloaded video. Set the command in `config.json` as `"transcribeCommand"`; `yt-dlp` runs it once per finished file, replacing `{}` with the video's path (covering playlists/Panopto folders automatically). If `{}` is omitted, the file path is appended.

[MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) has no headless CLI, so the practical macOS options are:

```jsonc
// Run a MacWhisper Shortcut you created (input file -> Transcribe -> save .txt next to the video):
"transcribeCommand": "shortcuts run \"Transcribe Video\" -i {}"

// Or just queue each video into the MacWhisper app (you click Transcribe/Export):
"transcribeCommand": "open -a MacWhisper {}"
```

Any other transcriber works too — e.g. a headless Whisper CLI: `"transcribeCommand": "whisper {} --model small --output_format txt"`. `-t` is opt-in and is ignored if `transcribeCommand` is empty.

#### Whisper on Windows (pure binary via Scoop)

On Windows you can transcribe with **no Python** using Purfview's standalone [Faster-Whisper-XXL](https://github.com/Purfview/whisper-standalone-win). There is no official Scoop bucket for it, so this repo ships a manifest (`bucket/faster-whisper-xxl.json`) that installs the official release binary. In PowerShell:

```powershell
# 1. Install Scoop (skip if you already have it)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression

# 2a. Install directly from the bundled manifest (adds a `whisper-faster` command):
scoop install .\bucket\faster-whisper-xxl.json

# 2b. ...or add this repo as a Scoop bucket and install by name:
#     scoop bucket add canvas-scraper https://github.com/<you>/canvas-scraper-cli
#     scoop install faster-whisper-xxl

# 3. Verify
whisper-faster --help
```

Then point `transcribeCommand` in `config.json` at the `whisper-faster` shim, sending transcripts to your `VIDEOS` folder:

```jsonc
"transcribeCommand": "whisper-faster {} --model small --language English --output_format txt --output_dir courses\\VIDEOS"
```

`yt-dlp` replaces `{}` with each video's path. Notes:
- `--output_dir` is where the `.txt`/`.srt` files are written (default: the current directory). Set it to wherever you want the transcripts; match your `-o` output path.
- Pick a model by speed/accuracy: `tiny` / `base` (fast, lower quality) → `small` / `medium` → `large-v3` (slowest, best). The standalone runs on CPU and is much faster with an NVIDIA GPU.
- Scoop extracts `.7z`, so the manifest installs a 7-Zip dependency; the first install prints a "No hash" warning (the manifest fills the hash on `scoop update`). If install can't find the exe, the archive layout changed across releases — drop `"extract_dir"` from the manifest.
- Run the scrape with `-t`, e.g. `node index.js -v -t https://<school_domain>/courses/<course_id>`.

#### Whisper on macOS (via Homebrew)

If you'd rather not use the MacWhisper GUI, install a headless Whisper with [Homebrew](https://brew.sh/). The simplest is OpenAI's Whisper, which transcribes the downloaded `.mp4` files directly:

```sh
brew install openai-whisper ffmpeg
whisper --help
```

Then set `transcribeCommand` in `config.json` (sending transcripts to your `VIDEOS` folder):

```jsonc
"transcribeCommand": "whisper {} --model small --language en --output_format txt --output_dir courses/VIDEOS"
```

Faster, native alternatives (both Apple-Silicon-accelerated) are also in Homebrew:
- **`brew install whisper-cpp`** — [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-cli`. It's much faster but needs a downloaded GGML model (`.bin`) and 16 kHz WAV input, so you'd convert with `ffmpeg` first inside the command.
- **`brew install whisperkit-cli`** — Apple's CoreML-based `whisperkit-cli`.

See the model/speed notes above; on Apple Silicon even `medium`/`large-v3` are practical with `whisper-cpp`/`whisperkit-cli`.

In addition to Canvas-hosted files, the scraper now also captures **externally-hosted links** found in assignment descriptions and module/quiz content:
- **Files** (PDFs, Office docs, etc.) are downloaded as-is.
- **Webpages** (e.g. a linked news article) are rendered to a **PDF archive** by the headless browser, named from the page title (e.g. `Journalism That Stands Apart … - The New York Times.pdf`). This is best-effort: paywalled or login-gated pages capture only what's publicly visible, and bot-protected sites may render a blocked page.
- **Videos** (YouTube, Panopto) are downloaded as `mp4` via `yt-dlp`.

Some course materials are **LTI external-tool launches** rather than direct files — most notably Harvard Business Publishing (HBS) cases, which link through Canvas (e.g. `…/external_tools/retrieve?url=…hbsp.harvard.edu…`). For HBS links the scraper performs the signed launch in the authenticated browser and, if the resulting page offers a **Download PDF** option, submits it and saves the PDF automatically (named from the case, e.g. `What Is Strategy.pdf`). This only works for items your institution has licensed for PDF download — exactly what you'd get by clicking the button yourself. Anything that can't be downloaded (a non-HBS tool, or an HBS item that only offers an online reader/video) is listed at the end of the run under "could not download" so you can open the Canvas URL while signed in and save it manually.

## Download File Structure

- ASSIGNMENTS
  - [\<Assignment\> (<(Grade %) or (Points Earned/Total Points) or (N/A) or (✅ or ❌)>)]
    - ASSIGNMENT
      - ASSIGNMENT.pdf
      - {Embedded Files}
      - {External Documents & Videos}
    - COMMENTS.txt
    - SUBMISSIONDETAILS.pdf
    - {Submission Files}
  - ASSIGNMENTS.pdf
- MODULES
  - MODULE SECTION
    - MODULE NAME
      - MODULE.pdf
      - {Embedded Files}
      - {External Documents & Videos}
  - MODULES.pdf
- QUIZZES
  - QUIZ SECTION
    - QUIZ NAME
      - QUIZ.pdf
      - {Embedded Files}
      - {External Documents & Videos}
  - QUIZZES.pdf
- VIDEOS
  - {Panopto folder name}
    - {Session recordings as mp4}
- STUDYNET
  - {NN - Material Name.pdf / .xlsx / …}
  - {NN - Website Name (LINK).url}
- HOMEPAGE.pdf

## Video Tutorial

Watch the video below for a quick guide on how to download and use the CLI!

[![Video Tutorial Thumbnail](https://img.youtube.com/vi/LkUe-pfXVFE/0.jpg)](https://www.youtube.com/watch?v=LkUe-pfXVFE)
