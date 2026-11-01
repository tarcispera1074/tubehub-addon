// TubeHub — Stremio/Nuvio addon with one browsable catalog per tube site.
//
// Each entry in sites.js becomes its own row in the app:
//     TubeHub: xHamster (HD) - Movies
//     TubeHub: xVideos (HD) - Movies
//     ...
//
// Add a site by adding it to sites.js; nothing else needs to change.

import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SITES, ENABLED } from "./sites.js";
import { checkProxyUrl, isSafePublicHost, parseHostList, normalizeHost } from "./allowlist.js";
import { decodeConfig, encodeConfig, looksLikeToken } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const CONFIGURE_HTML = readFileSync(join(HERE, "configure.html"), "utf8");

const PORT = Number(process.env.PORT || 7000);
const PER_PAGE = 24;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MINUTES || 10) * 60_000;
const PROXY_ALLOW_ANY = process.env.PROXY_ALLOW_ANY === "1";
const EXTRA_ALLOWED_HOSTS = parseHostList(process.env.ALLOWED_EXTRA_HOSTS || "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// ---------------------------------------------------------------------------
// LOGGING + SMALL HELPERS
// ---------------------------------------------------------------------------
function log(scope, message) {
  console.log(`[${scope}] ${message}`);
}

function safeDecode(v) {
  if (typeof v !== "string") return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
};

function sendJson(req, res, status, data, extra = {}) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...CORS,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (e.expires < Date.now()) {
    map.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(map, key, value, max = 400) {
  map.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  if (map.size > max) map.delete(map.keys().next().value);
}

// ---------------------------------------------------------------------------
// CACHES / STATE
// ---------------------------------------------------------------------------
const catalogCache = new Map();
const streamCache = new Map();
const learnedHosts = new Set();
const siteStats = new Map(); // siteId -> { lastCount, lastMs, lastError }

function learnHost(raw) {
  const h = normalizeHost(raw);
  if (!h || h.includes(":")) return;
  learnedHosts.add(h);
  const parts = h.split(".");
  if (parts.length > 2) learnedHosts.add(parts.slice(-2).join("."));
}

function proxyOptions() {
  return { allowAny: PROXY_ALLOW_ANY, extraHosts: EXTRA_ALLOWED_HOSTS, learned: learnedHosts };
}

// ---------------------------------------------------------------------------
// MANIFEST — built from the config carried in the install URL
// ---------------------------------------------------------------------------
const ALL_SITE_IDS = Object.keys(ENABLED);

const ALL_CATALOGS = Object.entries(ENABLED).map(([id, site]) => ({
  type: "movie",
  id: `tube_${id}`,
  name: `TubeHub: ${site.name} - Movies`,
  extra: [
    { name: "search", isRequired: false },
    { name: "skip", isRequired: false },
  ],
}));

const BASE_MANIFEST = {
  id: "com.tubehub.addon",
  version: pkg.version,
  name: "TubeHub",
  description: "One browsable catalog per tube site",
  logo: "https://www.xvideos.com/favicon.ico",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["tube:"],
  behaviorHints: { configurable: true },
};

/** Manifest exposing only the sites chosen in the install link. */
function buildManifest(sites) {
  const wanted = new Set(sites);
  return {
    ...BASE_MANIFEST,
    catalogs: ALL_CATALOGS.filter((c) => wanted.has(c.id.slice("tube_".length))),
  };
}

// Default manifest: every site (used when the URL carries no config).
const manifest = buildManifest(ALL_SITE_IDS);

// ---------------------------------------------------------------------------
// CATALOG
// ---------------------------------------------------------------------------
function itemId(siteId, url) {
  return `tube:${siteId}:${encodeURIComponent(url)}`;
}

function parseItemId(raw) {
  const s = safeDecode(String(raw || "")).replace(/^tube:/, "");
  const first = s.indexOf(":");
  if (first === -1) return null;
  const siteId = s.slice(0, first);
  let url = s.slice(first + 1);
  if (url.includes("%3A") || url.includes("%2F")) url = safeDecode(url);
  if (!ENABLED[siteId] || !/^https?:\/\//i.test(url)) return null;
  if (!isSafePublicHost(url)) return null;
  return { siteId, url };
}

async function getCatalog(siteId, { skip = 0, query = "" } = {}) {
  const site = ENABLED[siteId];
  if (!site) return [];
  const page = Math.floor(skip / PER_PAGE) + 1;
  const key = `${siteId}|${page}|${query.toLowerCase()}`;

  const cached = cacheGet(catalogCache, key);
  if (cached) return cached;

  const t0 = Date.now();
  let items = [];
  try {
    items = await site.list({ page, query });
  } catch (e) {
    siteStats.set(siteId, { lastError: e.message, lastMs: Date.now() - t0 });
    log(`CAT ${siteId}`, `error: ${e.message}`);
    return [];
  }

  const metas = items.slice(0, PER_PAGE).map((i) => {
    learnHost(i.url);
    if (i.poster) learnHost(i.poster);
    return {
      id: itemId(siteId, i.url),
      type: "movie",
      name: i.title,
      poster: i.poster || undefined,
      posterShape: "landscape",
    };
  });

  siteStats.set(siteId, { lastCount: metas.length, lastMs: Date.now() - t0 });
  log(`CAT ${siteId}`, `page ${page} -> ${metas.length} items (${Date.now() - t0}ms)`);
  cacheSet(catalogCache, key, metas);
  return metas;
}

// ---------------------------------------------------------------------------
// PROXY (HLS rewriting, allowlist, abort on disconnect)
// ---------------------------------------------------------------------------
function proxyBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"]?.split(",")[0]?.trim() || "http";
  const host =
    req.headers["x-forwarded-host"]?.split(",")[0]?.trim() || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function proxyLink(absUrl, referer, req) {
  let ext = ".ts";
  if (absUrl.includes(".m3u8")) ext = ".m3u8";
  else if (absUrl.includes(".key")) ext = ".key";
  return `${proxyBase(req)}/proxy/hls${ext}?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
}

function rewritePlaylist(text, baseUrl, referer, req) {
  const one = (raw) => {
    try {
      return proxyLink(new URL(raw, baseUrl).href, referer, req);
    } catch {
      return raw;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        if (!/URI="/i.test(t)) return line;
        return t.replace(/URI="([^"]+)"/gi, (_, u) => `URI="${one(u)}"`);
      }
      return one(t);
    })
    .join("\n");
}

function learnPlaylistHosts(text, baseUrl) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try {
      learnHost(new URL(t, baseUrl).hostname);
    } catch {}
  }
}

async function handleProxy(req, res, u) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS });
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(req, res, 405, { error: "Method not allowed" });
  }

  const raw = u.searchParams.get("url");
  const referer = u.searchParams.get("referer") || "";
  if (!raw) return sendJson(req, res, 400, { error: "Missing url" });

  const check = checkProxyUrl(raw, proxyOptions());
  if (!check.ok) {
    log("PROXY BLOCK", `${check.reason} ${check.host || String(raw).slice(0, 70)}`);
    return sendJson(req, res, 403, { error: "Host not allowed", reason: check.reason });
  }
  const target = check.url.toString();

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  const range = req.headers.range;
  const headers = { "user-agent": UA, accept: "*/*" };
  if (referer) headers.referer = referer;
  if (range) headers.range = range;

  try {
    const r = await fetch(target, { headers, redirect: "follow", signal: ac.signal });
    if (!r.ok && r.status !== 206) {
      log("PROXY FAIL", `${r.status} ${target.slice(0, 70)}`);
      return sendJson(req, res, r.status === 404 ? 404 : 502, { error: "Upstream error", status: r.status });
    }

    let type = r.headers.get("content-type") || "video/mp4";
    const isPlaylist = target.includes(".m3u8") || /mpegurl/i.test(type);

    if (isPlaylist) {
      const text = await r.text();
      learnPlaylistHosts(text, target);
      const body = Buffer.from(rewritePlaylist(text, target, referer, req), "utf-8");
      res.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
        ...CORS,
        "cache-control": "no-store",
        "content-length": body.length,
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    }

    if (type === "application/octet-stream") type = "video/mp4";
    const out = { "content-type": type, ...CORS, "cache-control": "no-store", "accept-ranges": r.headers.get("accept-ranges") || "bytes" };
    const len = r.headers.get("content-length");
    const cr = r.headers.get("content-range");
    if (len) out["content-length"] = len;
    if (cr) out["content-range"] = cr;

    res.writeHead(r.status === 206 ? 206 : 200, out);
    if (!r.body || req.method === "HEAD") return res.end();

    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((d) => res.once("drain", d));
    }
    res.end();
  } catch (e) {
    if (e.name === "AbortError") return;
    log("PROXY ERR", e.message);
    if (!res.headersSent) sendJson(req, res, 502, { error: "Proxy failed" });
    else res.end();
  }
}

// ---------------------------------------------------------------------------
// STREAM
// ---------------------------------------------------------------------------
async function handleStream(rawId, req) {
  const parsed = parseItemId(rawId);
  if (!parsed) {
    log("STREAM", `refused id: ${String(rawId).slice(0, 80)}`);
    return [];
  }
  const { siteId, url } = parsed;
  const site = ENABLED[siteId];

  const cached = cacheGet(streamCache, `${siteId}|${url}`);
  if (cached) return cached;

  log("STREAM", `${siteId} ${url}`);
  let media = null;
  try {
    media = await site.resolve(url);
  } catch (e) {
    log("STREAM", `resolve error: ${e.message}`);
  }
  if (!media?.url) {
    log("STREAM", "no playable media found");
    return [];
  }
  learnHost(media.url);
  log("VIDEO", `${media.quality} ${media.type} ${media.url.slice(0, 90)}`);

  const pageHost = normalizeHost(url);
  const streams = [
    {
      name: site.name,
      title: `⚡ ${media.quality || "auto"} (${media.type.toUpperCase()})`,
      url: media.url,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: { "User-Agent": UA, Referer: `https://${pageHost}/` } },
      },
    },
    {
      name: `${site.name} (proxy)`,
      title: `🛡️ ${media.quality || "auto"} (${media.type.toUpperCase()})`,
      url: `${proxyBase(req)}/proxy?url=${encodeURIComponent(media.url)}&referer=${encodeURIComponent(`https://${pageHost}/`)}`,
      behaviorHints: { notWebReady: false },
    },
  ];

  cacheSet(streamCache, `${siteId}|${url}`, streams, 300);
  return streams;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    let p = u.pathname;
    let token = null;
    let cfgSites = ALL_SITE_IDS;

    // Install links look like /<payload>.<sig>/manifest.json — decode first.
    const seg = p.split("/")[1] || "";
    if (looksLikeToken(seg)) {
      const decoded = decodeConfig(seg, { allSites: ALL_SITE_IDS });
      if (!decoded) {
        return sendJson(req, res, 404, {
          error: "Invalid or outdated config link",
          hint: "build a new one at /configure",
        });
      }
      token = seg;
      cfgSites = decoded.config.sites;
      p = p.slice(seg.length + 1) || "/";
      if (!p.startsWith("/")) p = "/" + p;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...CORS });
      return res.end();
    }

    if (p === "/configure") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(CONFIGURE_HTML),
      });
      return res.end(CONFIGURE_HTML);
    }

    if (p === "/sites.json") {
      return sendJson(
        req,
        res,
        200,
        ALL_SITE_IDS.map((id) => ({ id, name: ENABLED[id].name }))
      );
    }

    if (p === "/api/link") {
      const wanted = (u.searchParams.get("sites") || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => ALL_SITE_IDS.includes(s));
      const unique = [...new Set(wanted)];
      if (unique.length === 0) return sendJson(req, res, 400, { error: "Pick at least one site" });
      const t = encodeConfig({ sites: unique });
      return sendJson(req, res, 200, {
        token: t,
        sites: unique,
        url: `${proxyBase(req)}/${t}/manifest.json`,
      });
    }

    if (p === "/") {
      return sendJson(req, res, 200, {
        name: manifest.name,
        configure: "/configure",
        health: "/healthz",
        manifest: token ? `/${token}/manifest.json` : "/manifest.json",
      });
    }

    if (p === "/manifest.json") return sendJson(req, res, 200, buildManifest(cfgSites));

    if (p === "/healthz") {
      const sites = Object.entries(ENABLED).map(([id, site]) => ({
        id,
        name: site.name,
        ...(siteStats.get(id) || { lastCount: null }),
      }));
      return sendJson(req, res, 200, {
        ok: true,
        version: manifest.version,
        uptimeSeconds: Math.round(process.uptime()),
        sites: sites.length,
        catalogs: ALL_CATALOGS.length,
        perSite: sites,
        proxy: { allowAny: PROXY_ALLOW_ANY },
      });
    }

    if (p === "/proxy" || p.startsWith("/proxy/")) return handleProxy(req, res, u);

    if (p.startsWith("/catalog/movie/tube_")) {
      // Accepts both /catalog/movie/tube_x.json and /catalog/movie/tube_x/search=..&skip=..json
      const rest = p.slice("/catalog/movie/".length).replace(/\.json$/i, "");
      const slash = rest.indexOf("/");
      const catId = slash === -1 ? rest : rest.slice(0, slash);
      const extraStr = slash === -1 ? "" : rest.slice(slash + 1);
      const siteId = catId.replace(/^tube_/, "");
      // Only sites present in this install link may be browsed.
      if (!cfgSites.includes(siteId)) return sendJson(req, res, 200, { metas: [] });
      let skip = 0;
      let query = "";
      for (const part of extraStr.split("&")) {
        if (part.startsWith("skip=")) skip = Number(part.slice(5)) || 0;
        else if (part.startsWith("search=")) query = safeDecode(part.slice(7));
      }
      if (u.searchParams.has("skip")) skip = Number(u.searchParams.get("skip")) || skip;
      if (u.searchParams.has("search")) query = u.searchParams.get("search") || "";
      const metas = await getCatalog(siteId, { skip: Math.max(0, skip), query });
      return sendJson(req, res, 200, { metas, cacheMaxAge: 1800 });
    }

    if (p.startsWith("/meta/")) {
      const m = p.match(/\/meta\/movie\/(.+)\.json$/);
      const parsed = parseItemId(m ? m[1] : "");
      if (!parsed) return sendJson(req, res, 200, { meta: null });
      const name = safeDecode(parsed.url).split("/").filter(Boolean).pop() || "Video";
      return sendJson(req, res, 200, {
        meta: {
          id: itemId(parsed.siteId, parsed.url),
          type: "movie",
          name: name.replace(/[-_]/g, " ").slice(0, 120),
        },
      });
    }

    if (p.startsWith("/stream/")) {
      const m = p.match(/\/stream\/movie\/(.+)\.json$/);
      const parsed = m ? parseItemId(m[1]) : null;
      if (!parsed || !cfgSites.includes(parsed.siteId)) {
        return sendJson(req, res, 200, { streams: [] });
      }
      const streams = await handleStream(m[1], req);
      return sendJson(req, res, 200, { streams });
    }

    return sendJson(req, res, 404, { error: "Not found" });
  } catch (e) {
    log("FATAL", `${e.name}: ${e.message}`);
    if (!res.headersSent) {
      try {
        return sendJson(req, res, 500, { error: "Internal error" });
      } catch {}
    }
    try {
      res.end();
    } catch {}
  }
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));

server.listen(PORT, () => {
  console.log(`\n🚀 TubeHub on port ${PORT}`);
  console.log(`   Configure: http://localhost:${PORT}/configure`);
  console.log(`   Health:   http://localhost:${PORT}/healthz`);
  console.log(`   ${ALL_CATALOGS.length} site catalogs available`);
});

