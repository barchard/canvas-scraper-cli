import { test } from "node:test";
import assert from "node:assert/strict";

import helpers from "../scrapers/helpers.js";

const URL = "https://org.hosted.panopto.com/Panopto/Pages/Sessions/List.aspx#folderID=abc";

test("a non-zero exit is a failure and carries the stderr detail", () => {
  const r = helpers.videoOutcome({
    code: 1,
    newMediaCount: 0,
    archiveSkipped: false,
    stderr: "ERROR: unable to download webpage: HTTP Error 403",
    url: URL,
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /403/);
});

test("a clean exit that produced media is a success", () => {
  const r = helpers.videoOutcome({
    code: 0,
    newMediaCount: 3,
    archiveSkipped: false,
    stderr: "",
    url: URL,
  });
  assert.equal(r.ok, true);
});

test("a clean exit that only skipped already-archived items is a success (resume)", () => {
  const r = helpers.videoOutcome({
    code: 0,
    newMediaCount: 0,
    archiveSkipped: true,
    stderr: "",
    url: URL,
  });
  assert.equal(r.ok, true, "nothing new on a re-run is fine, not a failure");
});

test("a clean exit that downloaded nothing and skipped nothing is reported as a likely cookie wall", () => {
  const r = helpers.videoOutcome({
    code: 0,
    newMediaCount: 0,
    archiveSkipped: false,
    stderr: "",
    url: URL,
  });
  assert.equal(r.ok, false);
  assert.equal(r.empty, true);
  assert.match(r.message, /login|cookies|Panopto/i, "message points at the cookie/login cause");
});
