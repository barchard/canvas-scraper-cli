import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTranscribeCommand } from "../core/transcribe.js";

test("config command wins", () => {
  const r = resolveTranscribeCommand({ transcribeCommand: "foo {}" }, { has: () => true });
  assert.deepEqual(r, { command: "foo {}", source: "config" });
});

test("auto-detects by platform preference", () => {
  const has = (b) => ["whisper", "whisperkit-cli"].includes(b);
  const mac = resolveTranscribeCommand({}, { platform: "darwin", has });
  assert.equal(mac.tool, "whisperkit-cli");
  const win = resolveTranscribeCommand({}, { platform: "win32", has });
  assert.equal(win.tool, "whisper");
});

test("none installed", () => {
  const r = resolveTranscribeCommand({}, { platform: "darwin", has: () => false });
  assert.equal(r.source, "none");
  assert.equal(r.command, "");
});
