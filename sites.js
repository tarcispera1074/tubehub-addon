// Per-site definitions. Each site needs two things:
//   list({ page, query }) -> [{ url, title, poster }]
//   resolve(videoUrl)     -> { url, type, quality } | null
//
// Add a site by adding an entry here; server.js picks it up automatically and
// exposes one browsable catalog per entry.

import { load } from "cheerio";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export async function getHtml(url, { timeoutMs = 20000, referer } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { "user-agent": UA, accept: "text/html,application/xhtml+xml" };
    if (referer) headers.referer = referer;
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers });
    if (!r.ok) return { ok: false, status: r.status, html: "" };
    return { ok: true, status: r.status, html: await r.text() };
  } catch {
    return { ok: false, status: 0, html: "" };
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

/**
 * Generic listing scrape: follow anchors whose href contains `linkPart`, take
 * the anchor title (or image alt / text), and its image as poster.
 */
function scrapeList(html, { linkPart, base, abs = true }) {
  const $ = load(html);
  const items = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!linkPart.test(href)) return;
    let url;
    try {
      url = new URL(href, base).href;
    } catch {
      return;
    }
    if (!url.startsWith("http")) return;

    const img = $(el).find("img").first();
    const poster =
      (img.attr("src") && !img.attr("src").startsWith("data:")
        ? img.attr("src")
        : "") ||
      img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("data-original") ||
      "";

    const title =
      ($(el).attr("title") || "").trim() ||
      (img.attr("alt") || "").trim() ||
      $(el).find("p, span, .title").first().text().trim() ||
      decodeURIComponent(url.split("/").filter(Boolean).pop() || "")
        .replace(/[-_]/g, " ")
        .replace(/\.(?:html?|php)$/i, "")
        .trim();

    if (!url || !title) return;
    items.push({ url, title: title.replace(/\s+/g, " ").slice(0, 120), poster });
  });
  return dedupe(items);
}

/** Pick the best mp4 by quality hint in the filename. */
function bestMp4(urls) {
  const scored = urls
    .filter((u) => !/trailer|preview|sample|thumb/i.test(u))
    .map((u) => {
      let score = 0;
      const m = u.match(/(\d{3,4})p/);
      if (m) score = Number(m[1]);
      else if (/mp4_hd/i.test(u)) score = 720;
      else if (/mp4_sd/i.test(u)) score = 480;
      return { u, score };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.u || null;
}

function allMedia(html, ext) {
  const re = new RegExp(`https?:\\\\?\\/\\\\?\\/[^"'\\s\\\\]+\\.${ext}[^"'\\s\\\\]*`, "gi");
  return [...html.matchAll(re)].map((m) => m[0].replace(/\\\//g, "/"));
}

export const SITES = {
  xhamster: {
    name: "xHamster (HD)",
    base: "https://xhamster.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://xhamster.com/search/${encodeURIComponent(query)}?page=${page}`
        : `https://xhamster.com/newest/${page}`;
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /\/videos\/[a-z0-9-]{6,}/i, base: "https://xhamster.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://xhamster.com/" });
      if (!r.ok) return null;
      const urls = allMedia(r.html, "m3u8");
      const master = urls.find((u) => /media=hls|master/i.test(u)) || urls[0];
      if (!master) return null;
      return { url: master, type: "hls", quality: "auto" };
    },
  },

  xvideos: {
    name: "xVideos (HD)",
    base: "https://www.xvideos.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://www.xvideos.com/?k=${encodeURIComponent(query)}&p=${page - 1}`
        : `https://www.xvideos.com/new/${page}`;
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/video\./i, base: "https://www.xvideos.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://www.xvideos.com/" });
      if (!r.ok) return null;
      // The HLS master carries 720p even when the mp4 endpoint is SD-only.
      const hls = allMedia(r.html, "m3u8");
      const master = hls.find((u) => /hls-cdn|master/i.test(u)) || hls[0];
      if (master) return { url: master, type: "hls", quality: "up to 720p" };
      const urls = allMedia(r.html, "mp4").filter((u) => /\.mp4/i.test(u));
      const best = urls.find((u) => /mp4_hd/i.test(u)) || urls.find((u) => /mp4_sd/i.test(u)) || bestMp4(urls);
      if (!best) return null;
      return { url: best, type: "mp4", quality: /hd/i.test(best) ? "720p+" : "sd" };
    },
  },

  tnaflix: {
    name: "TnaFlix (HD)",
    base: "https://www.tnaflix.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://www.tnaflix.com/search.php?what=${encodeURIComponent(query)}&page=${page}`
        : `https://www.tnaflix.com/new/${page}`;
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /video\d+/i, base: "https://www.tnaflix.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://www.tnaflix.com/" });
      if (!r.ok) return null;
      const urls = allMedia(r.html, "mp4");
      const best = bestMp4(urls);
      if (!best) return null;
      const m = best.match(/(\d{3,4})p/);
      return { url: best, type: "mp4", quality: m ? m[1] + "p" : "hd" };
    },
  },

  perfectgirls: {
    name: "PerfectGirls",
    base: "https://www.perfectgirls.net",
    // Disabled: the public page only exposes a ~360p preview clip; the full
    // scene is behind a signed redirect we cannot reach anonymously. Kept here
    // as the starting point for when that is solved.
    enabled: false,
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://www.perfectgirls.net/search/?q=${encodeURIComponent(query)}`
        : `https://www.perfectgirls.net/latest/${page}`;
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /\/video\/\d+/i, base: "https://www.perfectgirls.net" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://www.perfectgirls.net/" });
      if (!r.ok) return null;
      const urls = allMedia(r.html, "mp4");
      const full = urls.filter((u) => !/preview|trailer/i.test(u));
      const pick = bestMp4(full) || urls[0];
      if (!pick) return null;
      const preview = /preview|trailer/i.test(pick);
      return { url: pick, type: "mp4", quality: preview ? "preview" : "hd" };
    },
  },
};

/** Sites that are switched on (everything without enabled:false). */
export const ENABLED = Object.fromEntries(
  Object.entries(SITES).filter(([, s]) => s.enabled !== false)
);
