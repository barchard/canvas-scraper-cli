import { test } from "node:test";
import assert from "node:assert/strict";

import helpers from "../scrapers/helpers.js";
import {
  isZoomHost,
  ltiScidFromUrl,
  ltiApiHeaders,
  playableMp4s,
  formatZoomTime,
  recordingFilename,
  transcriptToVtt,
} from "../scrapers/zoom/index.js";

test("isZoomHost matches zoom.us and subdomains only", () => {
  assert.equal(isZoomHost("https://example.zoom.us/rec/play/abc"), true);
  assert.equal(isZoomHost("https://zoom.us/signin"), true);
  assert.equal(isZoomHost("https://ssrweb.zoom.us/replay02/x.mp4"), true);
  assert.equal(isZoomHost("https://evilzoom.us/"), false);
  assert.equal(isZoomHost("https://zoom.us.evil.com/"), false);
  assert.equal(isZoomHost("not a url"), false);
});

test("ltiScidFromUrl reads lti_scid only from the Zoom LTI host", () => {
  assert.equal(
    ltiScidFromUrl("https://applications.zoom.us/api/v1/lti/rich/plg/setup?lti_scid=abc123"),
    "abc123"
  );
  assert.equal(ltiScidFromUrl("https://applications.zoom.us/lti/rich"), null);
  assert.equal(ltiScidFromUrl("https://example.com/?lti_scid=abc"), null);
});

test("playableMp4s keeps only MP4 files that have a play URL", () => {
  const files = [
    { fileType: "TIMELINE", playUrl: "" },
    { fileType: "M4A", playUrl: "https://example.zoom.us/rec/play/a" },
    { fileType: "MP4", playUrl: "https://example.zoom.us/rec/play/b" },
    { fileType: "MP4", playUrl: "" },
  ];
  assert.deepEqual(
    playableMp4s(files).map((f) => f.playUrl),
    ["https://example.zoom.us/rec/play/b"]
  );
  assert.deepEqual(playableMp4s(null), []);
});

test("formatZoomTime converts the UTC start time into the meeting's zone", () => {
  assert.equal(formatZoomTime("2026-11-09 23:55:17", "America/New_York"), "2026-11-09 1855");
  assert.equal(formatZoomTime("2026-11-09 23:55:17", "Not/AZone"), "2026-11-09 2355");
  assert.equal(formatZoomTime("garbage", "UTC"), "");
});

test("recordingFilename is date + topic, with part numbers for multi-MP4 meetings", () => {
  const rec = {
    startTime: "2026-10-05 19:56:00",
    timezone: "America/New_York",
    topic: "FIN 202 Financial: Management / Recitation",
  };
  assert.equal(
    recordingFilename(rec, 0, 1),
    "2026-10-05 1556 FIN 202 Financial- Management - Recitation"
  );
  assert.match(recordingFilename(rec, 1, 2), / - part 2$/);
});

test("transcriptToVtt renders numbered cues with speaker voice tags", () => {
  const vtt = transcriptToVtt([
    { startTime: "00:01:41.690", endTime: "00:01:43.009", text: "Hello, friends.", userName: "Ana" },
    { startTime: "00:04:07.270", endTime: "00:04:08.170", text: "Hey folks" },
    { startTime: "", endTime: "", text: "dropped" },
  ]);
  assert.equal(
    vtt,
    "WEBVTT\n\n1\n00:01:41.690 --> 00:01:43.009\n<v Ana>Hello, friends.\n\n2\n00:04:07.270 --> 00:04:08.170\nHey folks\n"
  );
});

test("netscapeCookieText renders cookies in yt-dlp's cookie-file format", () => {
  const text = helpers.netscapeCookieText([
    { name: "a", value: "1", domain: ".zoom.us", path: "/", secure: true, expires: 1800000000.5 },
    { name: "b", value: "2", domain: "example.zoom.us", expires: -1 },
    { name: "", value: "skip", domain: "x" },
  ]);
  assert.equal(
    text,
    "# Netscape HTTP Cookie File\n" +
      ".zoom.us\tTRUE\t/\tTRUE\t1800000000\ta\t1\n" +
      "example.zoom.us\tFALSE\t/\tFALSE\t0\tb\t2\n"
  );
});

test("ltiApiHeaders keeps only the XSRF token and x-zm-* headers", () => {
  assert.deepEqual(
    ltiApiHeaders({
      "x-xsrf-token": "t",
      "x-zm-aid": "acct",
      "x-zm-cluster-id": "us01",
      cookie: "secret",
      "user-agent": "UA",
    }),
    {
      accept: "application/json, text/plain, */*",
      "x-xsrf-token": "t",
      "x-zm-aid": "acct",
      "x-zm-cluster-id": "us01",
    }
  );
});
