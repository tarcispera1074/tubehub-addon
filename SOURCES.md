# Source tracker

Status of every site from the original 58-site list (58 = 17 + 13 + 15 + 12 + 1).

A site is `LIVE` only if it passed all four checks: catalog ≥ 8 real titles →
video page resolves → media returns 200/206 `video/*`|`mpegurl` → the **proxied**
URL works too.

## LIVE — 17

| Site | Host | How it resolves | Quality |
|---|---|---|---|
| xHamster | xhamster.com | page HLS | adaptive |
| xVideos | xvideos.com | page HLS | up to 720p |
| TnaFlix | tnaflix.com | page mp4 | mp4 |
| JustPorn | justporn.com | page mp4 | 720p |
| HandjobHub | handjobhub.com | page mp4 | mp4 |
| OK.xxx | ok.xxx | page mp4/HLS | 720p |
| XGroovy | xgroovy.com | page mp4 | 1080p |
| TheyAreHuge | theyarehuge.com | page mp4 | mp4 |
| PornID | pornid.xxx | page mp4 | 720p |
| ZbPorn | zbporn.com | page mp4 | mp4 |
| MegaTube | megatube.xxx | page mp4 | mp4 |
| Shameless | shameless.com | page mp4 | 720p |
| SuperPorn | superporn.com | page mp4 | mp4 |
| PornOne | pornone.com | page mp4 | mp4 |
| RedTube | redtube.com | **keyless api.redtube.com** + mediaDefinition | 1080p |
| YouPorn | youporn.com | listing + mediaDefinition | 720p |
| Tube8 | tube8.com | /porn-video/ + mediaDefinition | 1080p |

RedTube/YouPorn/Tube8 share one resolver (`resolveAylo`): the page's
`mediaDefinition` → `/media/mp4?s=…` → per-quality JSON. **No API key needed** —
the earlier assumption that these needed Aylo partner keys was wrong.

## Investigated and rejected — 13

| Site | Finding |
|---|---|
| PornHub | Anonymous traffic receives a **12-second preview** playlist, not the video |
| PerfectGirls | Only a 360p preview clip is public |
| EPorner | Catalog API works, but `/xhr/video/…` returns `available:false, code:3` even with session cookies |
| PornDoe | Listing is JS-rendered |
| Beeg | SPA — 7.9 KB shell, no API references |
| XNXX | 53 KB page, zero video links |
| 3Movs | Exposes `get_file/…/<id>.mp4/` but returns a **1×1 placeholder GIF** (200 `image/gif`) to non-browser requests; `_lq` variant 403s. Hotlink-protected — re-tested after the thumbnail fix |
| PussySpace | The "video" URL returns an HTML page, not media |
| Rat.xxx | Video page 404s from the server |
| BustyBus | Signed HLS URL fails on refetch |
| SexVid | No video links in the listing (JS) |
| VipWank | No video links in the listing (JS) |
| BigPorn | Only tag pages in the HTML (JS) |

## JavaScript listings — 15

Porn · PornHat · Porn300 · LetsPorn · CumLouder · AlohaTube · TubeV ·
JennyMovies · ColliderPorn · HQPorn · GrannyTube · HotPornTubes · ZZZTube ·
XCafe · XXXBunker

## Blocked by Cloudflare (403) — 12

IXXX · SpankBang · Fuq · TubeGalore · Sxyprn · Tiava · MatureTube · Qorno ·
4Tube · MelonsTube · DinoTube · LobsterTube

## Missing — 1

**Xbabe** — no domain supplied.

---

## What would change a verdict

- **The 15 JS listings** — recoverable one at a time by reading each site's JS
  bundle for its XHR endpoint. The Aylo sites (RedTube/YouPorn/Tube8) show the
  pattern: find the JSON the grid is built from, not the rendered HTML.
- **Beeg / XNXX** — same idea, but their endpoints are inside the bundle.
- **The 12 Cloudflare sites** — need different egress (the worker trick used by
  the PornX11 addon). Unproven; maybe 20–30% would pass.
- **PornHub / PerfectGirls** — only previews are public. Nothing server-side fixes
  that.
