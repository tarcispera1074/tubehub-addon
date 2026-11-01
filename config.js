// Config codec: the install URL carries the user's choices.
//
//   /<payload>.<sig>/manifest.json
//
// payload = base64url(JSON) of { s: ["xhamster", ...] }
// sig     = truncated HMAC-SHA256 so a hand-edited URL cannot enable things
//           you did not offer (and so unknown sites are silently dropped).
//
// Set CONFIG_SECRET in production and keep it stable: changing it invalidates
// every install link in the wild.

import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.CONFIG_SECRET || "tubehub-dev-secret-change-me";
const SIG_LEN = 12;

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url").slice(0, SIG_LEN);
}

/** @param {{sites: string[]}} cfg */
export function encodeConfig(cfg) {
  const payload = Buffer.from(JSON.stringify({ s: cfg.sites }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * @param {string} token
 * @param {{allSites: string[]}} opts
 * @returns {{config: {sites: string[]}, explicit: true} | null}
 */
export function decodeConfig(token, { allSites }) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!sig || sig.length !== SIG_LEN) return null;

  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!obj || !Array.isArray(obj.s)) return null;
    // Unknown ids are dropped rather than trusted.
    const sites = [...new Set(obj.s.filter((id) => typeof id === "string" && allSites.includes(id)))];
    if (sites.length === 0) return null;
    return { config: { sites }, explicit: true };
  } catch {
    return null;
  }
}

/** Roughly: does this path segment look like a config token? */
export function looksLikeToken(segment) {
  return /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}$/.test(segment || "");
}
