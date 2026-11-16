import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import helpers from "../scrapers/helpers.js";
import { readJSON } from "./scrape.js";

export const MEDIA_RE = /\.(mp4|m4a|mkv|webm|mp3|wav)$/i;

/** True when `bin` resolves on PATH (`where` on Windows, `command -v` elsewhere). */
export function onPath(bin, platform = process.platform) {
  const r =
    platform === "win32"
      ? spawnSync("where", [bin], { stdio: "ignore" })
      : spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
  return r.status === 0;
}

// Candidate transcribers in preference order per platform. "{}" is the video
// path and "{dir}" its folder, so transcripts land next to each video.
const WHISPER_ARGS = "{} --model small --output_format txt --output_dir {dir}";
const CANDIDATES = {
  darwin: [
    ["mlx_whisper", "mlx_whisper {} --model mlx-community/whisper-small-mlx --output-format txt --output-dir {dir}"],
    ["whisperkit-cli", "whisperkit-cli transcribe --audio-path {} --report --report-path {dir}"],
    ["whisper", `whisper ${WHISPER_ARGS}`],
  ],
  win32: [
    ["whisper-faster", `whisper-faster ${WHISPER_ARGS}`],
    ["faster-whisper-xxl", `faster-whisper-xxl ${WHISPER_ARGS}`],
    ["whisper", `whisper ${WHISPER_ARGS}`],
  ],
  linux: [
    ["faster-whisper-xxl", `faster-whisper-xxl ${WHISPER_ARGS}`],
    ["whisper", `whisper ${WHISPER_ARGS}`],
  ],
};

/**
 * Picks the transcribe command: the config's `transcribeCommand` when set,
 * otherwise the first supported transcriber installed on this system.
 * @returns {{command:string, source:"config"|"auto"|"none", tool?:string}}
 */
export function resolveTranscribeCommand(
  config = {},
  { platform = process.platform, has = (b) => onPath(b, platform) } = {}
) {
  const configured = (config.transcribeCommand || "").trim();
  if (configured) return { command: configured, source: "config" };
  const list = CANDIDATES[platform] || CANDIDATES.linux;
  for (const [bin, command] of list) {
    if (has(bin)) return { command, source: "auto", tool: bin };
  }
  return { command: "", source: "none" };
}

/** Message shown when nothing is configured or installed. */
export const NO_TRANSCRIBER_HINT =
  'No transcriber found. Install one (macOS: `pip install mlx-whisper` or `brew install openai-whisper`; Windows: `scoop install .\\bucket\\faster-whisper-xxl.json`) or set "transcribeCommand" in config.json.';

/** Finds every downloaded media file under `dir`. */
export function findMedia(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMedia(full));
    else if (MEDIA_RE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Re-runs the transcriber over every video under `dir`, one at a time.
 * Throws when no transcriber is configured/installed or no videos exist.
 * @returns {Promise<number>} how many videos were processed
 */
export async function retranscribeAll(dir) {
  const t = resolveTranscribeCommand(readJSON("config.json", "config"));
  if (!t.command) throw new Error(NO_TRANSCRIBER_HINT);
  if (t.source === "auto") {
    helpers.print("INFO", "TRANSCRIBE", `Auto-detected transcriber: ${t.tool}`, 0);
  }
  const files = findMedia(dir);
  if (!files.length) throw new Error(`No downloaded videos found in ${dir}`);
  helpers.print("INFO", "TRANSCRIBE", `Re-transcribing ${files.length} video(s)`, 0);
  for (let i = 0; i < files.length; i++) {
    helpers.print("INFO", "TRANSCRIBE", `[${i + 1}/${files.length}] ${files[i]}`, 0);
    await helpers.runTranscribeOne(t.command, files[i], i + 1, files.length);
  }
  return files.length;
}
