import { test } from "node:test";
import assert from "node:assert/strict";

import {
  videoAuthHosts,
  studyNetAuthHosts,
  hasCookiesForHosts,
  hasVideoAuthCookies,
} from "../core/login.js";

test("videoAuthHosts always includes Panopto and skips public providers", () => {
  assert.deepEqual(videoAuthHosts({}), ["panopto.com"]);
  assert.deepEqual(videoAuthHosts(), ["panopto.com"]);

  // Public hosts (YouTube/Vimeo) need no login cookie, so they're excluded;
  // a genuinely login-gated extra is kept.
  const hosts = videoAuthHosts({ videoHosts: ["youtube.com", "vimeo.com", "media.university.edu"] });
  assert.deepEqual(hosts, ["panopto.com", "media.university.edu"]);
});

test("hasVideoAuthCookies detects a Panopto session cookie (subdomain, leading dot)", () => {
  const hosts = videoAuthHosts({});
  const cookies = [
    { name: "canvas_session", domain: ".instructure.com", value: "a" },
    { name: ".ASPXAUTH", domain: "myorg.hosted.panopto.com", value: "b" },
  ];
  assert.equal(hasVideoAuthCookies(cookies, hosts), true);
});

test("hasVideoAuthCookies matches the bare host and an explicit leading dot", () => {
  const hosts = videoAuthHosts({});
  assert.equal(hasVideoAuthCookies([{ domain: "panopto.com" }], hosts), true);
  assert.equal(hasVideoAuthCookies([{ domain: ".panopto.com" }], hosts), true);
});

test("hasVideoAuthCookies is false when only Canvas cookies were captured", () => {
  const hosts = videoAuthHosts({});
  const cookies = [
    { name: "canvas_session", domain: ".instructure.com", value: "a" },
    { name: "_csrf_token", domain: "school.instructure.com", value: "b" },
  ];
  assert.equal(hasVideoAuthCookies(cookies, hosts), false);
});

test("a YouTube cookie does not count as a login-gated video-host cookie", () => {
  const hosts = videoAuthHosts({});
  assert.equal(hasVideoAuthCookies([{ domain: ".youtube.com" }], hosts), false);
});

test("hasVideoAuthCookies tolerates empty/missing input", () => {
  const hosts = videoAuthHosts({});
  assert.equal(hasVideoAuthCookies([], hosts), false);
  assert.equal(hasVideoAuthCookies(undefined, hosts), false);
  assert.equal(hasVideoAuthCookies([{}], hosts), false);
});

test("a configured login-gated extra host is detected", () => {
  const hosts = videoAuthHosts({ videoHosts: ["media.university.edu"] });
  assert.equal(
    hasVideoAuthCookies([{ domain: "video.media.university.edu" }], hosts),
    true
  );
});

test("studyNetAuthHosts is study.net, and its cookies are detected across subdomains", () => {
  const hosts = studyNetAuthHosts();
  assert.deepEqual(hosts, ["study.net"]);

  // The session shows up on www./lti./watermark. subdomains after the launch.
  assert.equal(hasCookiesForHosts([{ name: "PHPSESSID", domain: "www.study.net" }], hosts), true);
  assert.equal(hasCookiesForHosts([{ domain: "watermark.study.net" }], hosts), true);
  assert.equal(hasCookiesForHosts([{ domain: "study.net" }], hosts), true);

  // Canvas-only cookies don't count as a Study.Net session.
  assert.equal(hasCookiesForHosts([{ domain: ".instructure.com" }], hosts), false);
  // A lookalike domain must not match.
  assert.equal(hasCookiesForHosts([{ domain: "notstudy.net.evil.com" }], hosts), false);
});

test("hasVideoAuthCookies is an alias of hasCookiesForHosts", () => {
  const cookies = [{ domain: "org.hosted.panopto.com" }];
  const hosts = videoAuthHosts({});
  assert.equal(
    hasVideoAuthCookies(cookies, hosts),
    hasCookiesForHosts(cookies, hosts)
  );
});
