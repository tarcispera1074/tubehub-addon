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
    const path = href.replace(/^https?:\/\/[^/]+/, "");
    if (!linkPart.test(href) && !linkPart.test(path)) return;
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

    const UI_WORDS = /^(add to\b|add\b|like\b|share\b|favorite|favourite|watch later|download|play\b|hd\b|4k\b|new\b|hot\b)$/i;
    let title = ($(el).attr("title") || "").trim() || (img.attr("alt") || "").trim() ||
      $(el).find("p, span, .title, .video-title, .thumb-title").first().text().trim();

    // Fall back to the URL slug when the markup gives nothing useful.
    if (!title || UI_WORDS.test(title)) {
      let path = "";
      try {
        path = new URL(url).pathname;
      } catch {}
      const words = decodeURIComponent(path)
        .split("/")
        .filter(Boolean)
        .filter((s) => !/^\d+$/.test(s));
      title = (words[words.length - 1] || "").replace(/\.(?:html?|php)$/i, "").replace(/[-_]/g, " ").trim();
    }
    if (!title) {
      const num = url.match(/\d{3,}/);
      title = num ? `Video ${num[0]}` : "Video";
    }

    if (!url) return;
    items.push({ url, title: title.replace(/\s+/g, " ").slice(0, 120), poster });
  });
  return dedupe(items);
}

/** Pick the best mp4: explicit quality wins, otherwise the first in the page. */
function bestMp4(urls) {
  const clean = urls.filter((u) => !/trailer|preview|sample|thumb/i.test(u));
  if (!clean.length) return null;
  let best = null;
  let bestScore = -1;
  let bestIdx = Infinity;
  clean.forEach((u, i) => {
    const m = u.match(/(\d{3,4})p/);
    const score = m
      ? Number(m[1])
      : /mp4_hd/i.test(u)
        ? 720
        : /mp4_sd/i.test(u)
          ? 480
          : 0;
    if (score > bestScore || (score === bestScore && i < bestIdx)) {
      best = u;
      bestScore = score;
      bestIdx = i;
    }
  });
  return best;
}

function allMedia(html, ext) {
  const re = new RegExp(`https?:\\\\?\\/\\\\?\\/[^"'\\s\\\\]+\\.${ext}[^"'\\s\\\\]*`, "gi");
  return [...html.matchAll(re)].map((m) => m[0].replace(/\\\//g, "/"));
}

/**
 * Shared resolver for the Aylo family (RedTube, YouPorn): the page carries a
 * `mediaDefinition` array whose videoUrl points at `/media/<fmt>?s=…`, and that
 * endpoint returns JSON with one entry per quality.
 */
async function resolveAylo(pageHtml, pageUrl) {
  const m = pageHtml.match(/mediaDefinition:\s*(\[[\s\S]{0,4000}?\])/);
  if (!m) return null;
  let defs;
  try {
    defs = JSON.parse(m[1].replace(/\\\//g, "/"));
  } catch {
    return null;
  }
  for (const want of ["mp4", "hls"]) {
    const def = defs.find((d) => d.format === want);
    if (!def?.videoUrl) continue;
    let abs;
    try {
      abs = new URL(def.videoUrl, pageUrl).href;
    } catch {
      continue;
    }
    const r = await getHtml(abs);
    if (!r.ok) continue;
    let arr;
    try {
      arr = JSON.parse(r.html);
    } catch {
      continue;
    }
    const best = arr
      .map((e) => ({ e, q: Number(e.quality || e.height || 0) }))
      .sort((a, b) => b.q - a.q)[0];
    const vu = (best?.e?.videoUrl || "").replace(/\\\//g, "/");
    if (!vu) continue;
    return { url: vu, type: want, quality: best.q ? best.q + "p" : "auto" };
  }
  return null;
}

/**
 * Shared resolver for the "get_file" CMS family: these sites put a plain
 * mp4/m3u8 on the video page. Prefer HLS, else the best mp4.
 */
function resolveFromPage(html) {
  const hls = allMedia(html, "m3u8").filter((u) => !/trailer|preview|sample/i.test(u));
  if (hls.length) return { url: hls[0], type: "hls", quality: "auto" };
  const mp4 = allMedia(html, "mp4");
  const best = bestMp4(mp4);
  if (best) {
    const m = best.match(/(\d{3,4})p/);
    return { url: best, type: "mp4", quality: m ? m[1] + "p" : "hd" };
  }
  return null;
}

/** Build a listing URL; null means "this site has no further pages". */
function listingUrl(base, page, sub = "") {
  if (page > 1) return null;
  return `${base}${sub}`;
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

  // --- "get_file" CMS family: plain mp4/m3u8 on the page --------------------
  // Verified playable. Only the first listing page exists, so skip>0 ends the
  // row instead of repeating page 1.
  justporn: {
    name: "JustPorn",
    base: "https://justporn.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://justporn.com/search/${encodeURIComponent(query)}/`
        : listingUrl("https://justporn.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /\/video[\/-]/i, base: "https://justporn.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://justporn.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  handjobhub: {
    name: "HandjobHub",
    base: "https://handjobhub.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://handjobhub.com/search/${encodeURIComponent(query)}/`
        : `https://handjobhub.com/?page=${page}`;
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /\/video[\/-]/i, base: "https://handjobhub.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://handjobhub.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  okxxx: {
    name: "OK.xxx",
    base: "https://ok.xxx",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://ok.xxx/search/${encodeURIComponent(query)}/`
        : listingUrl("https://ok.xxx", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /\/video[\/-]/i, base: "https://ok.xxx" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://ok.xxx/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  xgroovy: {
    name: "XGroovy",
    base: "https://xgroovy.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://xgroovy.com/search/${encodeURIComponent(query)}/`
        : listingUrl("https://xgroovy.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/videos\/\d+/i, base: "https://xgroovy.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://xgroovy.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  theyarehuge: {
    name: "TheyAreHuge",
    base: "https://www.theyarehuge.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://www.theyarehuge.com/search/${encodeURIComponent(query)}/`
        : listingUrl("https://www.theyarehuge.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/v\/[a-z0-9-]+/i, base: "https://www.theyarehuge.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://www.theyarehuge.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  pornid: {
    name: "PornID",
    base: "https://www.pornid.xxx",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://www.pornid.xxx/search/${encodeURIComponent(query)}/`
        : listingUrl("https://www.pornid.xxx", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, {
        linkPart: /^\/[a-z0-9-]{15,}\.html$/i,
        base: "https://www.pornid.xxx",
      });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://www.pornid.xxx/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  // --- verified full-length additions --------------------------------------
  zbporn: {
    name: "ZbPorn",
    base: "https://zbporn.com",
    async list({ page = 1, query = "" }) {
      const url = query ? `https://zbporn.com/search/${encodeURIComponent(query)}/` : listingUrl("https://zbporn.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/videos\/\d+/i, base: "https://zbporn.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://zbporn.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  megatube: {
    name: "MegaTube",
    base: "https://megatube.xxx",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://megatube.xxx/search/${encodeURIComponent(query)}/`
        : listingUrl("https://megatube.xxx", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/videos\/\d+/i, base: "https://megatube.xxx" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://megatube.xxx/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  shameless: {
    name: "Shameless",
    base: "https://shameless.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://shameless.com/search/${encodeURIComponent(query)}/`
        : listingUrl("https://shameless.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/videos\/[a-z0-9-]+/i, base: "https://shameless.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://shameless.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  superporn: {
    name: "SuperPorn",
    base: "https://www.superporn.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://www.superporn.com/search/${encodeURIComponent(query)}/`
        : listingUrl("https://www.superporn.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/video\/[a-z0-9-]+/i, base: "https://www.superporn.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://www.superporn.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  pornone: {
    name: "PornOne",
    base: "https://pornone.com",
    async list({ page = 1, query = "" }) {
      const url = query
        ? `https://pornone.com/search/${encodeURIComponent(query)}/`
        : listingUrl("https://pornone.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, {
        linkPart: /^\/[a-z0-9-]+\/[a-z0-9-]{12,}/i,
        base: "https://pornone.com",
      });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://pornone.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
    },
  },

  // --- Aylo family: public legacy JSON API, no key ---------------------------
  redtube: {
    name: "RedTube (HD)",
    base: "https://www.redtube.com",
    async list({ page = 1, query = "" }) {
      // api.redtube.com is public and keyless: it returns title, duration,
      // page url and thumbnails. `ordering=newest` gives a browsable "latest".
      const search = query || "all";
      const url =
        `https://api.redtube.com/?data=redtube.Videos.searchVideos&output=json` +
        `&search=${encodeURIComponent(search)}&page=${page}&thumbsize=big&ordering=newest`;
      const r = await getHtml(url);
      if (!r.ok) return [];
      let j;
      try {
        j = JSON.parse(r.html);
      } catch {
        return [];
      }
      return (j.videos || [])
        .map((v) => v.video)
        .filter((v) => v && v.url && v.title)
        .map((v) => ({ url: v.url, title: v.title, poster: v.default_thumb || v.thumb || "" }));
    },
    async resolve(videoUrl) {
      const page = await getHtml(videoUrl);
      if (!page.ok) return null;
      return resolveAylo(page.html, videoUrl);
    },
  },

  youporn: {
    name: "YouPorn (HD)",
    base: "https://www.youporn.com",
    async list({ page = 1, query = "" }) {
      // The listing page embeds /watch/<id>/ links in its initial state.
      const url = query
        ? `https://www.youporn.com/?search=${encodeURIComponent(query)}`
        : listingUrl("https://www.youporn.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/watch\/\d+/i, base: "https://www.youporn.com" });
    },
    async resolve(videoUrl) {
      const page = await getHtml(videoUrl);
      if (!page.ok) return null;
      return resolveAylo(page.html, videoUrl);
    },
  },

  tube8: {
    name: "Tube8 (HD)",
    base: "https://www.tube8.com",
    async list({ page = 1, query = "" }) {
      // Video pages live at /porn-video/<id>/ and the listing links straight to them.
      const url = query
        ? `https://www.tube8.com/search/?q=${encodeURIComponent(query)}`
        : listingUrl("https://www.tube8.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/porn-video\/\d+/i, base: "https://www.tube8.com" });
    },
    async resolve(videoUrl) {
      const page = await getHtml(videoUrl);
      if (!page.ok) return null;
      return resolveAylo(page.html, videoUrl);
    },
  },

  letsporn: {
    name: "LetsPorn",
    base: "https://letsporn.com",
    async list({ page = 1, query = "" }) {
      // Video pages are /<slug>-<id> with no path prefix.
      const url = query
        ? `https://letsporn.com/search/${encodeURIComponent(query)}/`
        : listingUrl("https://letsporn.com", page, "/");
      if (!url) return [];
      const r = await getHtml(url);
      if (!r.ok) return [];
      return scrapeList(r.html, { linkPart: /^\/[a-z0-9-]{10,}-\d{3,}$/i, base: "https://letsporn.com" });
    },
    async resolve(videoUrl) {
      const r = await getHtml(videoUrl, { referer: "https://letsporn.com/" });
      return r.ok ? resolveFromPage(r.html) : null;
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
