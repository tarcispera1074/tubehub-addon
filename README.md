# TubeHub — Stremio/Nuvio addon

One **browsable catalog per tube site**. Each site in `sites.js` becomes its own
row in the app:

```
TubeHub: xHamster (HD) - Movies
TubeHub: xVideos (HD) - Movies
TubeHub: TnaFlix (HD) - Movies
```

Rows are browsable (no search required) and paginate with `skip`.

## Configure page

Open `/configure` for a picker: tick the sites you want, hit **Build install link**,
and install the URL it gives you.

```
https://<host>/configure                              ← the picker
https://<host>/<payload>.<sig>/manifest.json          ← what you install
```

Your selection is encoded **in the URL** (base64 + HMAC), so there is no database
and no account: the server just decodes it per request and exposes only those
rows. Visiting the plain `/manifest.json` with no config exposes every site.

Set `CONFIG_SECRET` in production and keep it stable — changing it invalidates
every install link already in the wild.

## Status

| Site | Catalog | Stream | Quality |
|---|---|---|---|
| xHamster | ✅ | ✅ HLS | adaptive |
| xVideos | ✅ | ✅ HLS | up to 720p |
| TnaFlix | ✅ | ✅ MP4 | 1080p |
| PerfectGirls | ⚠️ disabled | — | only a 360p preview is public; full scene is behind a signed redirect |

## Requirements

- Node.js **20.18.1 or newer**

## Install & run

```bash
npm install
npm start
```

Then in Nuvio/Stremio: **Addons → Install from URL** →
`http://<your-ip>:7000/manifest.json`

## Endpoints

| Path | Purpose |
|------|---------|
| `/configure` | Picker that builds an install link |
| `/sites.json` | Site list used by the picker |
| `/api/link?sites=a,b` | Returns the encoded install URL |
| `/manifest.json` | Manifest (one catalog per enabled site) |
| `/healthz` | Per-site last result count and timing |
| `/catalog/movie/tube_<site>.json` | Browsable catalog |
| `…/tube_<site>/search=<q>&skip=24.json` | Search + pagination |
| `/meta/movie/tube:<site>:<url>.json` | Metadata |
| `/stream/movie/tube:<site>:<url>.json` | Direct + proxied stream |
| `/proxy?url=…&referer=…` | Media proxy with HLS rewriting |

## Adding a site

Add an entry to `SITES` in `sites.js`:

```js
mysite: {
  name: "MySite (HD)",
  base: "https://mysite.com",
  async list({ page, query }) { /* -> [{ url, title, poster }] */ },
  async resolve(videoUrl) {      /* -> { url, type, quality } */ },
}
```

It appears as a new catalog on restart. Set `enabled: false` to keep a site in
the file but hide it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7000` | HTTP port |
| `PUBLIC_BASE_URL` | – | Force the base used in proxied links |
| `CACHE_TTL_MINUTES` | `10` | Catalog/stream cache lifetime |
| `ALLOWED_EXTRA_HOSTS` | – | Extra media hosts the proxy may fetch |
| `PROXY_ALLOW_ANY` | `0` | `1` removes the host allowlist (**trusted use only**) |

## Security

The proxy is not an open relay: loopback, private, link-local and every IPv6
literal are rejected, and media hosts must be known, configured, or seen in a
real result. Malformed ids return an empty list instead of crashing.

## Notes

- Stream URLs are usually **signed and IP-bound to the server**. Playback
  through `/proxy` is the reliable path; the direct link works when the player
  honours `proxyHeaders`.
- If you deploy to a datacenter (Render etc.), some sites may block the IP; the
  catalog will still load but streams can fail. Check `/healthz`.
- Sites change their markup; when a row goes empty, the fix is that site's
  `list()`/`resolve()`.

## Legal

You are responsible for how you use this. Only stream content you have the right
to access in your jurisdiction.
