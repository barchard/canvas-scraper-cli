# Canvas Scraper CLI

A NodeJS command-line interface for scraping and downloading data (e.g. assignments and modules) from a Canvas course.

## Dependencies

Canvas-Scraper uses [Puppeteer](https://pptr.dev/), a headless browser, to navigate and scrape data from Canvas. This requires some form of [Chromium](https://www.chromium.org/chromium-projects/) to be available on the system. The easiest way to do this is by installing [Google Chrome](https://www.google.com/chrome/).

To download embedded videos (saved as `mp4`), Canvas-Scraper shells out to [yt-dlp](https://github.com/yt-dlp/yt-dlp), which must be installed and available on your `PATH` (e.g. `brew install yt-dlp` on macOS). It handles [YouTube](https://www.youtube.com/) and [Panopto](https://www.panopto.com/) links. If `yt-dlp` is not installed, video links are skipped (with a warning) and the rest of the scrape continues normally.

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
  url                      Course Homepage URL (e.g. https://<school_domain>/courses/<course_id>)

Options:
  -o, --output <dir_name>  output directory name (default: "courses/course")
  -c, --cookies <path>     path to cookies file (default: "cookies.json")
  -a                       scrape assignments (default: false)
  -m                       scrape modules (default: false)
  -q                       scrape quizzes (default: false)
  -h, --help               display help for command
```

Use any combination of the `a`, `m`, and `q` flags to choose what to scrape. If none are provided, all of them are scraped.

In addition to Canvas-hosted files, the scraper now also captures **externally-hosted links** found in assignment descriptions and module/quiz content: documents (e.g. case PDFs) are downloaded directly, and videos (YouTube, Panopto) are downloaded as `mp4` via `yt-dlp`.

Some course materials are **LTI external-tool launches** rather than direct files — most notably Harvard Business Publishing cases, which link through Canvas (e.g. `…/external_tools/retrieve?url=…hbsp.harvard.edu…`). These can't be downloaded automatically: opening them performs a signed launch into a paywalled third-party site that returns a viewer, not a file. The scraper detects these links and lists them at the end of the run (under "could not download") so you can open each Canvas URL while signed in and save the case manually.

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
- HOMEPAGE.pdf

## Video Tutorial

Watch the video below for a quick guide on how to download and use the CLI!

[![Video Tutorial Thumbnail](https://img.youtube.com/vi/LkUe-pfXVFE/0.jpg)](https://www.youtube.com/watch?v=LkUe-pfXVFE)
