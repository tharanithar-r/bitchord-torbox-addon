/**
 * The cache-coverage probe.
 *
 * Run this before trusting the design: it is the one measurement that decides
 * whether "cached releases play in seconds" is the normal path or the exception.
 * A debrid cache for music is thin, and how thin is specific to an account.
 *
 *   npm run probe                 # read-only: plan, library counts, cache hit rate
 *   npm run probe -- --add        # also add one cached release and probe its files
 *   npm run probe -- --limit 20   # more albums in the sample
 *
 * Nothing here is used by the server; it exists to answer questions once.
 */
import { loadConfig, loadDotEnv } from '../src/config.js';
import { KINDS, type Kind } from '../src/db.js';
import { searchIndexers } from '../src/acquire/indexers.js';
import { probeUrl } from '../src/probe/audio.js';
import { extensionOf, claimsLossless } from '../src/parse.js';
import { TorBoxClient } from '../src/torbox.js';

const ALBUM_QUERIES = [
  'Pink Floyd The Dark Side of the Moon',
  'Radiohead In Rainbows',
  'Daft Punk Random Access Memories',
  'Fleetwood Mac Rumours',
  'Miles Davis Kind of Blue',
  'Nirvana Nevermind',
  'The Weeknd After Hours',
  'Hans Zimmer Interstellar',
  'Michael Jackson Thriller',
  'A. R. Rahman Ponniyin Selvan',
  'Ilaiyaraaja Thiruvasagam',
  'Anirudh Ravichander Vikram',
];

function argValue(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function line(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.torboxKey) {
    console.error('TORBOX_KEY is missing from .env — nothing can be measured without it.');
    process.exit(1);
  }
  const torbox = new TorBoxClient(cfg.torboxKey);
  const limit = numberArg('limit', 8);
  const doAdd = argValue('add');

  console.log('\n── Account ─────────────────────────────────────────────');
  try {
    const me = await torbox.me();
    const plan = String((me.plan as unknown) ?? me.plan_id ?? 'unknown');
    console.log(`  plan${' '.repeat(30)}${plan}`);
    for (const key of ['email', 'is_subscribed', 'premium_expires_at', 'total_downloaded']) {
      if (me[key] !== undefined) line(key, String(me[key]));
    }
  } catch (error) {
    console.log(`  account lookup failed: ${(error as Error).message}`);
  }

  console.log('\n── Library ─────────────────────────────────────────────');
  let libraryFiles = 0;
  for (const kind of KINDS) {
    try {
      const page = await torbox.list(kind, { limit: 100, files: true });
      const files = page.flatMap((item) => item.files ?? []);
      libraryFiles += files.length;
      line(`${kind} (first page)`, `${page.length} items, ${files.length} files`);
      const audio = files.filter((f) => extensionOf(String(f.short_name ?? '')) !== '');
      const sample = audio
        .map((f) => String(f.short_name ?? ''))
        .filter((name) => /\.(flac|alac|wav|aiff|m4a|ape|wv|dsf|dff)$/i.test(name));
      if (sample.length > 0) line(`  lossless-looking files`, sample.length);
    } catch (error) {
      line(kind, `failed: ${(error as Error).message}`);
    }
  }
  line('total files seen', libraryFiles);

  console.log(`\n── Cache coverage (${limit} albums, free indexers) ───────────`);
  const queries = ALBUM_QUERIES.slice(0, limit);
  const found: Array<{ query: string; hash: string; name: string; seeders: number | null; magnet: string }> = [];
  for (const query of queries) {
    const releases = await searchIndexers(query, { minSeeders: 1, limit: 10 });
    const best = releases.find((r) => claimsLossless(r.name)) ?? releases[0];
    if (!best) {
      line(query.slice(0, 32), 'no releases found');
      continue;
    }
    found.push({ query, hash: best.hash, name: best.name, seeders: best.seeders, magnet: best.magnet });
    line(query.slice(0, 32), `${best.seeders ?? '?'} seeders · ${best.name.slice(0, 46)}`);
  }

  if (found.length === 0) {
    console.log('  nothing to check');
    return;
  }

  const cached = await torbox.checkCached(
    found.map((f) => f.hash),
    { kind: 'torrents', listFiles: true },
  );
  const cachedCount = found.filter((f) => cached[f.hash]).length;
  console.log('');
  line('cached on TorBox', `${cachedCount}/${found.length}`);
  line('hit rate', `${Math.round((cachedCount / found.length) * 100)}%`);

  for (const entry of found) {
    const hit = cached[entry.hash];
    if (!hit) continue;
    const files = (hit.files ?? []).map((f) => String(f.short_name ?? '')).filter(Boolean);
    line(`cached: ${entry.name.slice(0, 30)}`, `${files.length} files`);
  }

  const firstCached = found.find((f) => cached[f.hash]);
  if (!firstCached) {
    console.log('\n  No cached release in this sample → cached-inline playback will be rare;');
    console.log('  the 60/hour uncached queue (ACQUIRE_UNCACHED=1) is the real path for this account.');
    return;
  }

  if (!doAdd) {
    console.log('\n  Re-run with --add to prove the full path: add (cached-only) → files → link → header probe.');
    return;
  }

  console.log('\n── Full path on one cached release ─────────────────────');
  const added = await torbox.addTorrent(firstCached.magnet, { onlyIfCached: true, name: firstCached.name });
  line('added torrent id', added.torrentId);
  const item = await torbox.item('torrents', added.torrentId);
  const files = item?.files ?? [];
  line('files listed', files.length);
  const candidate = files.find((f) => /\.(flac|m4a|wav|aiff)$/i.test(String(f.short_name ?? '')));
  if (!candidate) {
    console.log('  no lossless file inside — stopping here');
    return;
  }
  line('probing file', String(candidate.short_name));
  const url = await torbox.requestLink('torrents', added.torrentId, Number(candidate.id));
  line('link host', new URL(url).host);
  const started = Date.now();
  const head = await probeUrl(url, { maxBytes: 512 * 1024 });
  line('probe latency (ms)', Date.now() - started);
  if (!head) {
    console.log('  probe returned nothing — the file head could not be read');
    return;
  }
  line('codec', head.codec);
  line('container', head.container);
  line('sample rate', head.sampleRate ?? 'unknown');
  line('bit depth', head.bitDepth ?? 'unknown');
  line('duration (s)', head.durationSec ? Math.round(head.durationSec) : 'unknown');
  line('isrc', head.isrc ?? '—');
  const tags = Object.entries(head.tags).slice(0, 6);
  if (tags.length > 0) console.log(`  tags: ${tags.map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

main().catch((error: unknown) => {
  console.error('probe failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
