# Source tracker

Status of every site from the original 58-site list (58 = 14 + 16 + 15 + 12 + 1).

A site is `LIVE` only if it passed all four checks: catalog ≥ 8 real titles →
video page resolves → media returns 200/206 `video/*`|`mpegurl` → the **proxied**
URL works too.

## LIVE — 14

| Site | Host | Quality |
|---|---|---|
| xHamster | xhamster.com | HLS adaptive |
| xVideos | xvideos.com | HLS up to 720p |
| TnaFlix | tnaflix.com | mp4 |
| JustPorn | justporn.com | mp4 720p |
| HandjobHub | handjobhub.com | mp4 |
| OK.xxx | ok.xxx | HLS 720p |
| XGroovy | xgroovy.com | mp4 1080p |
| TheyAreHuge | theyarehuge.com | mp4 |
| PornID | pornid.xxx | mp4 720p |
| ZbPorn | zbporn.com | mp4 |
| MegaTube | megatube.xxx | mp4 |
| Shameless | shameless.com | mp4 720p |
| SuperPorn | superporn.com | mp4 |
| PornOne | pornone.com | mp4 |

## Investigated and rejected — 16

Each of these was probed with a real request; the finding is in the last column.

| Site | Finding |
|---|---|
| PornHub | Anonymous traffic receives a **12-second preview** playlist, not the video |
| PerfectGirls | Only a 360p preview clip is public; full scene behind a signed redirect |
| EPorner | Catalog API works (titles/thumbs), but `/xhr/video/...` returns `available:false, code:3` — playback gated even with session cookies |
| PornDoe | Listing is JS-rendered (only category/tag/pornstar links). Not the same listing CMS as XGroovy |
| Beeg | SPA — 7.9 KB shell, no API references in the HTML |
| XNXX | 53 KB page, zero video links — JS-rendered |
| RedTube | JS-rendered; official API needs a free key |
| PussySpace | The "video" URL returns an HTML page, not media |
| 3Movs | Extractor returns a GIF; real video not found |
| BustyBus | HLS found, but the signed URL fails on refetch |
| Rat.xxx | Video links exist, media absent from the player markup |
| YouPorn | Links found, no playable media (API needs a key) |
| Tube8 | Links found, no playable media |
| SexVid | Links found, no playable media |
| VipWank | Links found, no playable media |
| BigPorn | Links found, no playable media |

## JavaScript listings — 15

Reachable, but the listing is built client-side; each needs its XHR endpoint
found in the site's JS bundle. One at a time, uncertain.

Porn · PornHat · Porn300 · LetsPorn · CumLouder · AlohaTube · TubeV ·
JennyMovies · ColliderPorn · HQPorn · GrannyTube · HotPornTubes · ZZZTube ·
XCafe · XXXBunker

## Blocked by Cloudflare (403) — 12

Cannot work from Render without different egress.

IXXX · SpankBang · Fuq · TubeGalore · Sxyprn · Tiava · MatureTube · Qorno ·
4Tube · MelonsTube · DinoTube · LobsterTube

## Missing — 1

**Xbabe** — no domain supplied; untested.

---

## What would change a verdict

- **PornHub / RedTube / YouPorn / Tube8** — the Aylo network publishes official
  APIs behind a free key. With a key these can become LIVE.
- **The 12 Cloudflare sites** — would need the worker-egress approach used by the
  PornX11 addon. Unproven here; maybe 20–30% would pass.
- **The 15 JS listings** — recoverable one by one by reading each site's JS
  bundle for its XHR endpoint. No batching, so it is the slowest path.
