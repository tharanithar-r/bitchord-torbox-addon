# TorBox Lossless — a BitChord addon

Streams the lossless (FLAC/ALAC/WAV/AIFF/DSD) and Dolby Atmos (E-AC-3 JOC) audio
that lives in a **TorBox** account straight into **BitChord** — Android, web,
Windows, macOS, Linux — as a native addon.

TorBox has no music catalogue: it holds files and hands out presigned links. So this
addon does three jobs:

1. **Index** — walks the account (`torrents`, `usenet`, `webdl`) and turns release and
   file names into searchable tracks.
2. **Measure** — reads the first bytes of each file to learn the real codec, sample
   rate, bit depth, duration and tags. No claim from a release name is trusted.
3. **Acquire** (optional) — when a track is asked for and not held, finds a release
   on free, keyless indexers and asks TorBox to add it *only if it is already cached*.

Nothing is ever re-encoded or proxied: the player receives TorBox's own presigned
CDN URL, so audio goes device → CDN directly.

---

## Quick start (on the VPS)

```bash
git clone <this repo> ~/bitchord-torbox-addon && cd ~/bitchord-torbox-addon
cp .env.example .env && chmod 600 .env
$EDITOR .env            # TORBOX_KEY, PATH_SECRET, PUBLIC_HOSTS, ADDON_DOMAIN
docker compose up -d --build
```

Then in BitChord: **Settings → Sources → Add an addon** → paste

```
https://<ADDON_DOMAIN>/<PATH_SECRET>
```

The row must **not** say "Outdated addon" (the manifest declares `bitchordAuth`), and
the health check must pass. `https://<ADDON_DOMAIN>/<PATH_SECRET>/admin` is the
operator page: counts, queue, per-auth-code counters, and two buttons (sync, probe).

Caddy obtains the TLS certificate automatically. The addon itself binds
`127.0.0.1:8099` (or `0.0.0.0` inside compose) and is never published directly.

### Before you trust the design, measure it

```bash
npm install
npm run probe          # plan, library counts, cache hit rate over ~8 albums
npm run probe -- --add # also add one cached release and probe its files end to end
```

The hit rate it prints decides whether "cached releases play instantly" is the normal
path or the exception — a debrid cache for music is thin, and how thin is specific to
an account.

## Running locally

```bash
npm install
npm run dev     # tsx, reads .env, listens on 127.0.0.1:8099
npm test        # 39 tests: parsers, probers, addon auth, routes
npm run build   # tsc → dist/
```

Without `TORBOX_KEY` the server still boots (index-only): manifest, health and an
empty search work, `/stream` answers 503. That is enough to check the addon URL from
the app before the key exists.

---

## Protocol surface

Everything is served under `/<PATH_SECRET>`:

| Route | Purpose |
|---|---|
| `GET /manifest.json` | identity, capabilities, the quality picker. Always public |
| `GET /search?q=&quality=&atmos=` | `{tracks:[…]}`; `200` with an empty array is a miss |
| `GET /stream/{id}?quality=&atmos=` | `{url, codec, container, manifest, sampleRate, bitDepth…}`; `404` = not held |
| `GET /health` | counts, for humans and uptime checks (no protocol requirement) |
| `GET /admin`, `POST /admin/sync`, `POST /admin/probe` | operator page and actions |

Design points that come straight from the official guide:

- **Quality picker is best-first.** `Max (best available)` / `Atmos (DD+ JOC)` /
  `Hi-Res (24-bit)` / `CD (16/44.1)`. BitChord sends the **first** option when the
  listener has not chosen, and it never looks for the word "lossless".
- **Tiers map, they do not filter.** `LOSSLESS→max`, `HIGH→cd`, `LOW→nothing` (a
  metered request is answered with a miss rather than a 120 MB FLAC).
- **`atmos=auto` prefers, never requires.** An Atmos request with no immersive mix
  falls back to stereo lossless instead of failing.
- **Dolby ≠ lossless.** Immersive rows are marked with `atmos: true`, `audioMode` and
  `audioModes: ["DOLBY_ATMOS"]`, and carry `codec: eac3-joc`.
- **`allowDownloads: 1`**, **`checkValidLossless: 0`** (no lossless-output gate).
- **Stream answers are reusable for five minutes**, so links are cached four minutes
  server-side and TorBox's own link is good for three hours.
- **Media URLs are never behind the verifier** — the player fetches them with no
  headers at all.

### Addon auth: observed, never enforced

The manifest declares `"bitchordAuth": true` and the official verifier
(`vendor/bitchord-addon-auth.mjs`, copied **unmodified**, sha256 `4e8c3b40…f7ba67d`)
runs on every request. Its result is logged and counted, never acted on.

That is deliberate. The proof is hardware-backed and only the release-signed Android
app can produce it, so **enforcing it would cut off BitChord web, Windows, macOS and
Linux** — which are platforms this addon is meant to serve. The path secret is the
real gate: long, env-only, rotatable, and redacted out of every log line.

What the logs show, per request:

```
auth=ok            # genuine Android install (claims: sub hash, ver)
auth=missing       # web / desktop / a fork / curl
auth=invalid_proof # `hosts` does not match the hostname in the addon URL
auth=stale_proof   # server clock is more than two minutes off — check NTP
```

Because the result is only logged, a wrong `PUBLIC_HOSTS` cannot lock you out; it
shows up as `invalid_proof` and is fixed by editing `.env`.

---

## How the index and the prober work

- `mylist?files=true` is walked per kind, one page at a time, resumable, re-walked
  every `SYNC_INTERVAL_MINUTES`.
- Only **music files** are indexed (`flac, alac, wav, aiff, ape, wv, dsf, dff, mp3,
  aac, m4a, ogg, opus`). Video containers are skipped on purpose: a film is an MKV
  with an audio track, and indexing those would bury the music.
- `Artist - Album (Year) [FLAC 24-96]` is split into artist/album/year; `1-02 Title`
  and `CD2/03 Title` become disc + track numbers.
- FTS5 with `remove_diacritics 2`, so `cafe` finds `Café`. Strict AND first, loose OR
  as a fallback — BitChord asks `title artist` and then the bare title.
- The prober makes **one small ranged read per file** (≤ 512 KiB) and walks FLAC
  metadata block headers, so album art is skipped rather than downloaded. It records
  the measured sample rate, bit depth, duration, ISRC and embedded tags, and only then
  does a row claim `HI_RES_LOSSLESS`, `LOSSLESS` or Dolby.

## Album art and lyrics

**Posters.** A BitChord search row carries `artworkURL`, and without one an addon
row has no image at all — a YouTube row brings its own thumbnail, an addon row
only shows what the addon sends. TorBox holds files, not artwork, so the honest
source is the cover embedded in the audio: the prober's single ranged read also
yields the FLAC `PICTURE` block or the MP4 `covr` atom, which is stored once per
album and served at `/<PATH_SECRET>/art/<album-key>` with an immutable one-year
cache. Rows then carry `artworkURL` and `albumArtworkURL`. A cover larger than
`PROBE_MAX_BYTES` is skipped rather than fetched separately.

Rips without an embedded picture are the gap that the Tidal/Qobuz addons never
have — their catalogue always carries a cover. So when a file has none, the prober
asks iTunes' public search API (free, no key) once per album, takes the result only
if the artist matches and the album name shares a word, downloads the 600×600 into
the same `art` table, and serves it from the same route. `ART_FINDER=0` turns that
off.

**Lyrics are the app's business, not ours.** The addon protocol has no lyrics
field — BitChord resolves lyrics itself from its own providers (lrc.red,
BiniLyrics, BetterLyrics, LRCLIB, KuGou, Genius…), keyed on the recording. What we
can do is give it the metadata those providers match on: `title`, `artist`,
`album` and `duration`, which the prober fills from the embedded tags. Two limits
worth knowing: the timing providers that match on an ISRC/recording id cannot be
reached for an addon row because those ids have no field in the protocol, and a
row that has never been probed has no duration and no tag-derived artist, which is
the usual reason a track shows no lyrics. Finish probing and the name-based
providers start working.

## Acquisition (optional)

Free discovery, no new subscriptions: **Knaben** (`Audio / Lossless`) → **apibay**
(category 104) → **torrents-csv**.

```
tap a song in BitChord
  └─ /search            → rows from the index
        └─ empty?       → acquireInline (cached-only, ≤4 s, one attempt per query per 10 min)
                            cached    → createtorrent(add_only_if_cached) → mylist?id → index → rows in the same answer
                            uncached  → queued, and the worker adds it if ACQUIRE_UNCACHED=1
  └─ /stream (miss)     → queue + `retryAfter` hint
```

The inline step exists because BitChord only calls `/stream` for a row it was
shown: an addon that answers an empty search has no second chance at that track.
One caveat that is the app's, not ours: BitChord caches a search answer for ten
minutes, so an album that finishes downloading is picked up by the app within that
window rather than instantly. The `retryAfter` field on a miss is the forward
compatible half of BitChord's own "ask the addon again" design (issue #1523),
which swaps a track to FLAC mid-song once released.

Guardrails: one release per infohash, `MAX_ALBUMS_PER_HOUR`, `MIN_SEEDERS`,
`MAX_ALBUM_GB`, and `ACQUIRE_ENABLED=0` as a kill switch. BitChord has no notice
channel, so a miss is a plain `404` and the work happens behind it — the track is
there on the next play.

## Limits worth knowing

- **TrueHD is not playable.** BitChord's codec list accepts `eac3-joc` (DD+ Atmos),
  not TrueHD; such files are indexed as unplayable and never offered.
- **DD+ Atmos detection is a heuristic.** MKV stores no JOC flag, so a 7.1 E-AC-3 bed
  (or a `joc` in CodecPrivate) is what marks a file immersive.
- **Music debrid caches are thin.** Expect the uncached path to matter; that is what
  `npm run probe` measures.
- **The index is a cache, not a source of truth.** Delete `data/index.db` and let it
  re-walk; nothing is lost but time.
- **Only what your account holds (or can cache) is playable.** This addon adds no
  catalogue of its own, and downloading copyrighted music is your responsibility.

## Files

```
src/config.ts        env → typed config (zod), .env reader
src/db.ts            SQLite (node:sqlite) schema, FTS5, queue, cursors
src/parse.ts         release/file name → artist, album, title, disc/track
src/probe/audio.ts   FLAC / MP4 / Matroska / WAV / AIFF head parsers
src/probe/worker.ts  batched, budgeted probing
src/torbox.ts        API client: envelope, rate limits, links, cache checks
src/sync.ts          library crawl → index
src/acquire/         free indexers + the guarded queue
src/auth/bitchord.ts verifier wrapper (log-only)
src/routes/          manifest, search/quality mapping, stream, health, admin
src/app.ts           Fastify assembly (routes, CORS, auth hook)
scripts/probe.ts     the one-off measurement tool
vendor/              the official verifier, unmodified
```
