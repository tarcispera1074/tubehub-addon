#!/usr/bin/env node
// Checks for TubeHub.
//   node verify.js
//
// unit checks on the host policy + a live smoke test that boots the addon and
// proves the per-site catalogs and the proxy guard work.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { checkProxyUrl, isBlockedIPv4, isHostAllowed, isSafePublicHost } from "./allowlist.js";
import { ENABLED } from "./sites.js";
import { encodeConfig, decodeConfig, looksLikeToken } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 7194;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;
function ok(name, cond, detail = "") {
  checks++;
  if (cond) return;
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log("host policy");
ok("loopback blocked", isSafePublicHost("127.0.0.1") === false);
ok("v6 blocked", isSafePublicHost("[::1]") === false);
ok("metadata blocked", isBlockedIPv4("169.254.169.254") === true);
ok("pornhub cdn allowed", isHostAllowed("ev.phncdn.com") === true);
ok("xhcdn allowed", isHostAllowed("video-nss.xhcdn.com") === true);
ok("xvideos cdn allowed", isHostAllowed("mp4-cdn77.xvideos-cdn.com") === true);
ok("tnaflix allowed", isHostAllowed("cdnl.tnaflix.com") === true);
ok("unknown refused", isHostAllowed("evil.example") === false);
eq("file scheme refused", checkProxyUrl("file:///etc/passwd").reason, "bad_scheme");
eq("loopback refused", checkProxyUrl("http://127.0.0.1/x").reason, "host_not_allowed");

console.log("sites module");
ok("sites defined", Object.keys(ENABLED).length >= 3);
for (const [id, s] of Object.entries(ENABLED)) {
  ok(`${id} has list()`, typeof s.list === "function");
  ok(`${id} has resolve()`, typeof s.resolve === "function");
  ok(`${id} has name`, typeof s.name === "string" && s.name.length > 0);
}

console.log("live server");
const child = spawn(process.execPath, ["server.js"], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});

async function up(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(45000) });
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
}

try {
  ok("server boots", await up());

  const m = await getJson("/manifest.json");
  eq("manifest status", m.status, 200);
  const pkg = JSON.parse(await readFile(join(HERE, "package.json"), "utf8"));
  eq("manifest version", m.body?.version, pkg.version);
  eq("one catalog per site", m.body?.catalogs?.length, Object.keys(ENABLED).length);
  ok(
    "catalog names look like rows",
    (m.body?.catalogs || []).every((c) => /^TubeHub: .+ - Movies$/.test(c.name)),
    JSON.stringify((m.body?.catalogs || []).map((c) => c.name))
  );
  ok(
    "no required extras (rows are browsable)",
    (m.body?.catalogs || []).every((c) => (c.extra || []).every((x) => !x.isRequired))
  );

  const health = await getJson("/healthz");
  eq("healthz status", health.status, 200);
  eq("healthz site count", health.body?.sites, Object.keys(ENABLED).length);

  for (const target of ["http://127.0.0.1:7000/manifest.json", "http://[::1]:7000/x", "file:///etc/passwd", "https://evil.example/x"]) {
    const r = await getJson(`/proxy?url=${encodeURIComponent(target)}`);
    eq(`proxy blocks ${target}`, r.status, 403);
  }

  const bad = await getJson(`/stream/movie/${encodeURIComponent("tube:nope:http://169.254.169.254/")}.json`);
  eq("refuses off-site stream id", bad.status, 200);
  eq("no streams for it", bad.body?.streams?.length, 0);
  eq("survives bad input", (await getJson("/healthz")).status, 200);

  // Catalogs hit the network; assert shape, not counts (sites can be down).
  for (const id of Object.keys(ENABLED)) {
    const c = await getJson(`/catalog/movie/tube_${id}.json`);
    eq(`catalog ${id} status`, c.status, 200);
    ok(`catalog ${id} returns array`, Array.isArray(c.body?.metas));
    if (c.body?.metas?.length) {
      const first = c.body.metas[0];
      ok(`catalog ${id} items have id/name`, typeof first.id === "string" && typeof first.name === "string" && first.name.length > 0);
    }
  }
  // --- config links --------------------------------------------------------
  console.log("config links");
  const cfgToken = encodeConfig({ sites: ["xhamster"] });
  ok("token shape", looksLikeToken(cfgToken));
  eq("round trip", decodeConfig(cfgToken, { allSites: ["xhamster", "xvideos"] })?.config.sites.join(","), "xhamster");
  const flipped = cfgToken.slice(0, -1) + (cfgToken.endsWith("A") ? "B" : "A");
  eq("tampered token rejected", decodeConfig(flipped, { allSites: ["xhamster"] }), null);
  eq("unknown ids dropped", decodeConfig(encodeConfig({ sites: ["nope"] }), { allSites: ["xhamster"] }), null);

  const link = await getJson("/api/link?sites=xhamster,tnaflix");
  eq("api link status", link.status, 200);
  ok("api link has url", typeof link.body?.url === "string" && link.body.url.endsWith("/manifest.json"));

  const tokenPath = new URL(link.body.url).pathname.replace(/\/manifest\.json$/, "");
  const scoped = await getJson(`${tokenPath}/manifest.json`);
  eq("scoped manifest status", scoped.status, 200);
  eq("scoped manifest has 2 catalogs", scoped.body?.catalogs?.length, 2);
  ok(
    "scoped manifest only chosen sites",
    (scoped.body?.catalogs || []).every((c) => ["tube_xhamster", "tube_tnaflix"].includes(c.id)),
    JSON.stringify((scoped.body?.catalogs || []).map((c) => c.id))
  );

  const excluded = await getJson(`${tokenPath}/catalog/movie/tube_xvideos.json`);
  eq("unselected site catalog is empty", excluded.body?.metas?.length, 0);

  const sitesList = await getJson("/sites.json");
  ok("sites.json lists sites", Array.isArray(sitesList.body) && sitesList.body.length >= 3);

  const conf = await fetch(`${BASE}/configure`);
  eq("configure page status", conf.status, 200);
  ok("configure page is html", (conf.headers.get("content-type") || "").includes("text/html"));
  ok("configure page has the builder", (await conf.text()).includes("Build install link"));

  eq("bad token rejected", (await getJson("/AAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAA/manifest.json")).status, 404);

} finally {
  try {
    child.kill("SIGKILL");
  } catch {}
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exitCode = 1;
}

