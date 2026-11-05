// Shared host policy for the media proxy (copy of the one used by the other
// two addons, with this addon's CDNs added).

export const DEFAULT_ALLOWED_HOSTS = [
  // pornhub
  "pornhub.com",
  "phncdn.com",
  // xhamster
  "xhcdn.com",
  "xhamster.com",
  "xhamster.desi",
  // xvideos
  "xvideos-cdn.com",
  "xvideos.com",
  "xvideos.es",
  // redtube
  "redtube.com",
  "rdtcdn.com",
  // tnaflix
  "tnaflix.com",
  "tnaflix.net",
  "zbporn.com",
  "megatube.xxx",
  "shameless.com",
  "superporn.com",
  "pornone.com",  // justporn / ok.xxx / pornid / xgroovy / theyarehuge / handjobhub
  "justporn.com",
  "ok.xxx",
  "pornid.xxx",
  "xgroovy.com",
  "theyarehuge.com",
  "handjobhub.com",
  "privatehost.com",  // perfectgirls
  "perfectgirls.net",
  "perfectgirls.xxx",
  // generic embed/CDN families seen on these sites
  "tnmr.org",
  "luluvdo.com",
  "luluvido.com",
  "lulustream.com",
  "streamtape.com",
  "streamtape.to",
  "dood.wf",
  "dood.so",
  "playmogo.com",
  "vidhide.com",
  "vidhidepro.com",
  "streamwish.com",
  "streamwish.to",
  "mixdrop.co",
  "mixdrop.to",
  "voe.sx",
  "filemoon.sx",
  "filemoon.to",
  "vidoza.net",
  "vidoza.org",
  "mp4upload.com",
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function normalizeHost(raw) {
  if (raw == null) return "";
  let value = String(raw).trim().toLowerCase();
  if (!value) return "";
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return "";
    }
  }
  if (value.startsWith("[")) value = value.slice(1);
  if (value.endsWith("]")) value = value.slice(0, -1);
  while (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

export function isBlockedIPv4(host) {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function isSafePublicHost(raw) {
  const h = normalizeHost(raw);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return false;
  if (h.includes(":")) return false;
  if (isBlockedIPv4(h)) return false;
  return true;
}

export function parseHostList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((s) => normalizeHost(s))
    .filter(Boolean);
}

function matchesSuffix(host, domains) {
  for (const d of domains) {
    if (!d) continue;
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

export function isHostAllowed(raw, opts = {}) {
  const h = normalizeHost(raw);
  if (!h) return false;
  if (opts.allowAny) return true;
  if (!isSafePublicHost(h)) return false;
  if (matchesSuffix(h, DEFAULT_ALLOWED_HOSTS)) return true;
  const extra = opts.extraHosts || [];
  if (extra.length && matchesSuffix(h, extra)) return true;
  if (opts.learned) {
    for (const learned of opts.learned) {
      if (learned && (h === learned || h.endsWith("." + learned))) return true;
    }
  }
  return false;
}

export function checkProxyUrl(rawUrl, opts = {}) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "bad_scheme" };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "credentials_in_url" };
  }
  const host = normalizeHost(u.hostname);
  if (!isHostAllowed(host, opts)) {
    return { ok: false, reason: "host_not_allowed", host };
  }
  return { ok: true, url: u, host };
}
