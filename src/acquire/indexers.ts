import type { Logger } from 'pino';
import { claimsLossless, isAtmosName, isHiResName } from '../parse.js';

/**
 * Finding a release to ask TorBox about — using only free, keyless sources.
 *
 * TorBox is a downloader, not a catalogue: it cannot tell you what exists. What it
 * *can* do is tell you, for one infohash, whether it already holds the bytes
 * (`checkcached`). So discovery lives here and the debrid account stays the only
 * paid component.
 *
 * Three sources, all verified working without an account:
 *
 *  - **Knaben** — an aggregator with a real `Audio / Lossless` category, which is
 *    what makes it the primary. Its API takes a JSON body and returns infohashes.
 *  - **apibay** — The Pirate Bay's own API, category 104 (audio).
 *  - **torrents-csv** — an open dataset with a different corpus, used last.
 *
 * Everything is normalised into one {@link Release} and filtered before it can
 * reach the queue: a name that claims lossless resolution, enough seeders to
 * matter, and a size that is plausibly one album rather than a discography.
 */
export type Release = {
  hash: string;
  magnet: string;
  name: string;
  sizeBytes: number | null;
  seeders: number | null;
  source: string;
};

export type IndexerOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
  minSeeders?: number;
  maxSizeBytes?: number;
  log?: Logger;
};

/** A bare hash magnet is enough for an add that must already be cached. */
export function magnetFor(hash: string, name: string): string {
  const dn = encodeURIComponent(name).replace(/%20/g, '+');
  return `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=${dn}`;
}

function hashOf(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : '';
}

function numOf(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Relevance of a release name to "I want this album, at the best quality". */
export function scoreRelease(release: Release, wantedTitle?: string): number {
  let score = 0;
  const name = release.name.toLowerCase();
  if (claimsLossless(release.name)) score += 40;
  if (isHiResName(release.name)) score += 20;
  if (isAtmosName(release.name)) score += 15;
  if (/\b(remaster|deluxe|expanded|anniversary)\b/.test(name)) score += 2;
  if (/\b(instrumental|karaoke|live|bootleg|demo)\b/.test(name)) score -= 10;
  if (/\b(discography|anthology|collection)\b/.test(name)) score -= 25;
  if (wantedTitle) {
    const tokens = wantedTitle
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3);
    const hits = tokens.filter((t) => name.includes(t)).length;
    if (tokens.length > 0) score += Math.round((hits / tokens.length) * 30);
  }
  score += Math.min(30, Math.log10((release.seeders ?? 0) + 1) * 12);
  return score;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function knaben(query: string, options: Required<Pick<IndexerOptions, 'timeoutMs'>> & IndexerOptions): Promise<Release[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = {
    query,
    // 1002000 is Knaben's "Audio / Lossless" category id.
    categories: [1002000],
    search_field: 'title',
    order_by: 'seeders',
    order_direction: 'desc',
    from: 0,
    size: options.limit ?? 20,
    hide_unsafe: true,
  };
  const data = (await fetchJson(
    fetchImpl,
    'https://api.knaben.org/v1',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    options.timeoutMs,
  )) as { hits?: Array<Record<string, unknown>> };
  return (data.hits ?? []).flatMap((hit) => {
    const hash = hashOf(hit.hash);
    if (!hash) return [];
    const name = String(hit.title ?? '');
    return [
      {
        hash,
        magnet: String(hit.magnetUrl ?? '') || magnetFor(hash, name),
        name,
        sizeBytes: numOf(hit.bytes),
        seeders: numOf(hit.seeders),
        source: 'knaben',
      },
    ];
  });
}

async function apibay(query: string, options: IndexerOptions): Promise<Release[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL('https://apibay.org/q.php');
  url.searchParams.set('q', query);
  url.searchParams.set('cat', '104');
  const data = (await fetchJson(fetchImpl, url.toString(), {}, options.timeoutMs ?? 8000)) as Array<
    Record<string, unknown>
  >;
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const hash = hashOf(row.info_hash);
    const name = String(row.name ?? '');
    if (!hash || name === '' || /no results returned/i.test(name)) return [];
    return [
      {
        hash,
        magnet: magnetFor(hash, name),
        name,
        sizeBytes: numOf(row.size),
        seeders: numOf(row.seeders),
        source: 'apibay',
      },
    ];
  });
}

async function torrentsCsv(query: string, options: IndexerOptions): Promise<Release[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL('https://torrents-csv.com/service/search');
  url.searchParams.set('q', query);
  url.searchParams.set('size', String(options.limit ?? 20));
  const data = (await fetchJson(fetchImpl, url.toString(), {}, options.timeoutMs ?? 8000)) as {
    torrents?: Array<Record<string, unknown>>;
  };
  return (data.torrents ?? []).flatMap((row) => {
    const hash = hashOf(row.infohash);
    const name = String(row.name ?? '');
    if (!hash) return [];
    return [
      {
        hash,
        magnet: magnetFor(hash, name),
        name,
        sizeBytes: numOf(row.size_bytes),
        seeders: numOf(row.seeders),
        source: 'torrents-csv',
      },
    ];
  });
}

/**
 * Ask every source, keep what is plausible, and rank it.
 *
 * Failures are per-source and silent by design: one indexer being down must not
 * cost the listener the other two.
 */
export async function searchIndexers(query: string, options: IndexerOptions = {}): Promise<Release[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  const settings = { timeoutMs: options.timeoutMs ?? 8000, limit: options.limit ?? 20 };
  const sources: Array<[string, (q: string, o: IndexerOptions) => Promise<Release[]>]> = [
    ['knaben', (q, o) => knaben(q, { ...settings, ...o })],
    ['apibay', apibay],
    ['torrents-csv', torrentsCsv],
  ];
  const results = await Promise.allSettled(
    sources.map(([, fn]) => fn(trimmed, { ...options, ...settings })),
  );
  const byHash = new Map<string, Release>();
  results.forEach((result, index) => {
    const label = sources[index]?.[0] ?? 'unknown';
    if (result.status === 'rejected') {
      options.log?.debug({ source: label, err: String(result.reason).slice(0, 120) }, 'indexer failed');
      return;
    }
    for (const release of result.value) {
      const existing = byHash.get(release.hash);
      if (!existing) {
        byHash.set(release.hash, release);
      } else if ((release.seeders ?? 0) > (existing.seeders ?? 0)) {
        byHash.set(release.hash, { ...existing, seeders: release.seeders });
      }
    }
  });

  const minSeeders = options.minSeeders ?? 1;
  const maxSize = options.maxSizeBytes ?? 8 * 1024 ** 3;
  return [...byHash.values()]
    .filter((r) => (r.seeders ?? 0) >= minSeeders)
    .filter((r) => (r.sizeBytes ?? 0) > 0 && (r.sizeBytes ?? 0) <= maxSize)
    .map((r) => ({ release: r, score: scoreRelease(r, trimmed) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.release);
}
