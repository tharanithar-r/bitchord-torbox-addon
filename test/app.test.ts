import { describe, expect, it } from 'vitest';
import type { Acquisition } from '../src/acquire/queue.js';
import { createApp } from '../src/app.js';
import type { AuthObserver } from '../src/auth/bitchord.js';
import type { Config } from '../src/config.js';
import { Store, trackId } from '../src/db.js';
import { createLogger } from '../src/log.js';
import type { Prober } from '../src/probe/worker.js';
import type { TorBoxClient } from '../src/torbox.js';
import { codecFromFormat } from '../src/routes/stream.js';

const SECRET = 'test-secret-0123456789';

function config(): Config {
  return {
    port: 0,
    bindHost: '127.0.0.1',
    publicHosts: ['addon.example.com'],
    pathSecret: SECRET,
    torboxKey: 'test-key',
    dbPath: ':memory:',
    logLevel: 'silent',
    acquire: { enabled: false, allowUncached: false, maxAlbumsPerHour: 0, minSeeders: 1, maxAlbumGb: 8 },
    probe: { batchSize: 0, maxBytes: 524288 },
    media: { proxy: false, secret: 'test-media-secret-0123456789', ttlSeconds: 1800 },
    syncIntervalMinutes: 0,
  };
}

const stubAuth = (): AuthObserver => ({
  observe: async () => ({ ok: false, code: 'missing' }),
  counters: () => ({ total: 0, ok: 0, byCode: {} }),
});

/** Only `requestLink` is exercised by the routes under test. */
const fakeTorbox = (): TorBoxClient =>
  ({
    requestLink: async () => 'https://cdn.torbox.example/media.flac',
  }) as unknown as TorBoxClient;

function seededStore(): Store {
  const store = Store.open(':memory:');
  store.upsertTrack({
    id: trackId('torrents', 1, 2),
    kind: 'torrents',
    itemId: 1,
    fileId: 2,
    title: 'Midnight Signal',
    artist: 'Example Artist',
    album: 'Night Drive',
    discNo: null,
    trackNo: 1,
    seq: 0,
    format: 'flac',
    codec: 'flac',
    container: 'flac',
    sampleRate: 96_000,
    bitDepth: 24,
    durationSec: 242,
    isrc: 'USRC12345678',
    sizeBytes: 42_000_000,
    lossless: true,
    atmos: false,
    playable: true,
  });
  // A probed row, as the real prober would leave it.
  store.recordProbe(trackId('torrents', 1, 2), {
    codec: 'flac',
    container: 'flac',
    sampleRate: 96_000,
    bitDepth: 24,
    durationSec: 242,
    isrc: 'USRC12345678',
    lossless: true,
    atmos: false,
    playable: true,
    note: null,
  });
  store.upsertTrack({
    id: trackId('torrents', 1, 3),
    kind: 'torrents',
    itemId: 1,
    fileId: 3,
    title: 'Midnight Signal (Atmos mix)',
    artist: 'Example Artist',
    album: 'Night Drive',
    discNo: null,
    trackNo: 2,
    seq: 1,
    format: 'eac3-joc',
    codec: 'eac3-joc',
    container: 'mp4',
    sampleRate: 48_000,
    bitDepth: null,
    durationSec: 242,
    isrc: null,
    sizeBytes: 12_000_000,
    lossless: false,
    atmos: true,
    playable: true,
  });
  return store;
}

function appWith(store: Store, torbox: TorBoxClient | undefined = fakeTorbox()) {
  return createApp({
    cfg: config(),
    store,
    log: createLogger('silent'),
    auth: stubAuth(),
    torbox,
  });
}

describe('manifest', () => {
  it('declares addon auth, downloads, and the quality picker best-first', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/manifest.json` });
    expect(response.statusCode).toBe(200);
    const manifest = response.json() as Record<string, unknown>;
    expect(manifest.id).toBe('app.torbox.lossless');
    expect(manifest.bitchordAuth).toBe(true);
    expect(manifest.allowDownloads).toBe(1);
    expect(manifest.checkValidLossless).toBe(0);
    const settings = manifest.settings as Array<{ key: string; options: Array<{ value: string }> }>;
    expect(settings[0]?.key).toBe('quality');
    // The first option is what BitChord sends when nothing is picked.
    expect(settings[0]?.options[0]?.value).toBe('max');
    expect(settings[0]?.options).toHaveLength(4);
    await app.close();
    store.close();
  });

  it('stays public even though the rest of the addon is verifier-instrumented', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/manifest.json` });
    expect(response.headers['access-control-allow-origin']).toBe('*');
    await app.close();
    store.close();
  });
});

describe('search', () => {
  it('answers with rows BitChord can match on', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/search?q=midnight%20signal&quality=max` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tracks: Array<Record<string, unknown>> };
    expect(body.tracks.length).toBeGreaterThan(0);
    const first = body.tracks[0];
    expect(first.id).toBe(trackId('torrents', 1, 2));
    expect(first.title).toBe('Midnight Signal');
    expect(first.artist).toBe('Example Artist');
    expect(first.duration).toBe(242);
    expect(first.audioQuality).toBe('HI_RES_LOSSLESS');
    await app.close();
    store.close();
  });

  it('marks the immersive row in every spelling the app reads', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({
      method: 'GET',
      url: `/${SECRET}/search?q=midnight%20signal&quality=atmos&atmos=auto`,
    });
    const body = response.json() as { tracks: Array<Record<string, unknown>> };
    const atmos = body.tracks.find((t) => t.atmos === true);
    expect(atmos).toBeDefined();
    expect(atmos?.audioModes).toEqual(['DOLBY_ATMOS']);
    expect(atmos?.format).toBe('eac3-joc');
    await app.close();
    store.close();
  });

  it('returns an empty array — not an error — for a query it holds nothing for', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/search?q=zzzzzz` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { tracks: unknown[] }).tracks).toEqual([]);
    await app.close();
    store.close();
  });

  it('serves nothing for a metered (LOW) request rather than a 120 MB FLAC', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/search?q=midnight&quality=LOW` });
    expect((response.json() as { tracks: unknown[] }).tracks).toEqual([]);
    await app.close();
    store.close();
  });
});

describe('stream', () => {
  it('hands back a URL with measured routing fields', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({
      method: 'GET',
      url: `/${SECRET}/stream/${encodeURIComponent(trackId('torrents', 1, 2))}?quality=max`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.url).toBe('https://cdn.torbox.example/media.flac');
    expect(body.codec).toBe('flac');
    expect(body.container).toBe('flac');
    expect(body.manifest).toBe('none');
    expect(body.encrypted).toBe(false);
    expect(body.sampleRate).toBe(96_000);
    expect(body.bitDepth).toBe(24);
    expect(String(body.quality)).toContain('Lossless');
    await app.close();
    store.close();
  });

  it('answers 404 for a track it does not hold, so resolution moves on', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({
      method: 'GET',
      url: `/${SECRET}/stream/${encodeURIComponent(trackId('torrents', 99, 99))}`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
    store.close();
  });

  it('answers 404 for a malformed id instead of throwing', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/stream/nonsense` });
    expect(response.statusCode).toBe(404);
    await app.close();
    store.close();
  });

  it('describes a miss that acquisition is working on, in the app\'s own debrid shape', async () => {
    const store = seededStore();
    const acquisition = {
      queueForTrack: async () => 1,
      budgetLeft: () => 6,
    } as unknown as Acquisition;
    const app = createApp({
      cfg: config(),
      store,
      log: createLogger('silent'),
      auth: stubAuth(),
      torbox: fakeTorbox(),
      acquisition,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/${SECRET}/stream/${encodeURIComponent(trackId('torrents', 99, 99))}`,
    });
    // Still a 404 (a failure is not cached, so the next play asks again), with the
    // forward-compatible retry hint BitChord's issue #1523 defines.
    expect(response.statusCode).toBe(404);
    const body = response.json() as Record<string, unknown>;
    expect(body.retryAfter).toBe(30);
    expect(String(body.error)).toContain('TorBox');
    await app.close();
    store.close();
  });

  it('answers 503 when no TorBox key is configured', async () => {
    const store = seededStore();
    // Built directly: passing `undefined` to appWith() would hit its default parameter.
    const app = createApp({
      cfg: config(),
      store,
      log: createLogger('silent'),
      auth: stubAuth(),
      torbox: undefined,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/${SECRET}/stream/${encodeURIComponent(trackId('torrents', 1, 2))}`,
    });
    expect(response.statusCode).toBe(503);
    await app.close();
    store.close();
  });
});

describe('stream latency and declarations', () => {
  it('answers immediately instead of waiting for a slow header read', async () => {
    const store = seededStore();
    let started = 0;
    const slowProber = {
      probe: () => {
        started += 1;
        return new Promise(() => {}); // never settles, like a stalled CDN read
      },
    } as unknown as Prober;
    const app = createApp({
      cfg: config(),
      store,
      log: createLogger('silent'),
      auth: stubAuth(),
      torbox: fakeTorbox(),
      prober: slowProber,
    });
    const began = Date.now();
    // t:1:3 is the unprobed row in the fixture.
    const response = await app.inject({
      method: 'GET',
      url: `/${SECRET}/stream/${encodeURIComponent(trackId('torrents', 1, 3))}?quality=max`,
    });
    expect(response.statusCode).toBe(200);
    expect(Date.now() - began).toBeLessThan(1000);
    expect(started).toBe(1); // the probe was kicked off, not awaited
    await app.close();
    store.close();
  });

  it('declares no codec for an m4a it has not opened', () => {
    expect(codecFromFormat('flac')).toBe('flac');
    expect(codecFromFormat('wav')).toBe('wav');
    // AAC or ALAC — only the file settles it, so nothing is claimed.
    expect(codecFromFormat('m4a')).toBeUndefined();
    expect(codecFromFormat('unknown', true)).toBe('flac');
  });
});

describe('signed media route (MEDIA_PROXY=1)', () => {
  const mediaConfig = (): Config => ({
    ...config(),
    media: { proxy: true, secret: 'test-media-secret-0123456789', ttlSeconds: 1800 },
  });

  function fakeCdn(): { impl: typeof fetch; calls: Array<{ url: string; range?: string }> } {
    const calls: Array<{ url: string; range?: string }> = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), range: headers.range });
      return new Response(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), {
        status: 206,
        headers: {
          'content-type': 'audio/flac',
          'content-range': 'bytes 0-3/1000',
          'content-length': '4',
        },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('answers with its own signed URL instead of the CDN one, and instantly', async () => {
    const store = seededStore();
    const app = createApp({
      cfg: mediaConfig(),
      store,
      log: createLogger('silent'),
      auth: stubAuth(),
      torbox: fakeTorbox(),
      fetchImpl: fakeCdn().impl,
    });
    const began = Date.now();
    const response = await app.inject({
      method: 'GET',
      url: `/${SECRET}/stream/${encodeURIComponent(trackId('torrents', 1, 2))}?quality=max`,
    });
    expect(response.statusCode).toBe(200);
    expect(Date.now() - began).toBeLessThan(500);
    const body = response.json() as Record<string, unknown>;
    // Extension on the path is the whole point: the player infers the container.
    expect(String(body.url)).toMatch(/\/media\/t%3A1%3A2\.flac\?exp=\d+&sig=[A-Za-z0-9_-]+$/);
    expect(body.codec).toBe('flac');
    await app.close();
    store.close();
  });

  it('serves the bytes and forwards the player Range header upstream', async () => {
    const store = seededStore();
    const cdn = fakeCdn();
    // Counts *link mints*, which is what the 300/min API budget is spent on.
    let mints = 0;
    const countingTorbox = {
      requestLink: async () => {
        mints += 1;
        return 'https://cdn.torbox.example/media.flac';
      },
    } as unknown as TorBoxClient;
    const app = createApp({
      cfg: mediaConfig(),
      store,
      log: createLogger('silent'),
      auth: stubAuth(),
      torbox: countingTorbox,
      fetchImpl: cdn.impl,
    });
    const stream = await app.inject({
      method: 'GET',
      url: `/${SECRET}/stream/${encodeURIComponent(trackId('torrents', 1, 2))}`,
    });
    const mediaUrl = new URL(String((stream.json() as Record<string, unknown>).url));
    const served = await app.inject({
      method: 'GET',
      url: `${mediaUrl.pathname}${mediaUrl.search}`,
      headers: { range: 'bytes=0-3' },
    });
    expect(served.statusCode).toBe(206);
    expect(served.headers['content-type']).toBe('audio/flac');
    expect(served.headers['content-range']).toBe('bytes 0-3/1000');
    expect(served.rawPayload.subarray(0, 4).toString('latin1')).toBe('fLaC');
    expect(cdn.calls[0]?.range).toBe('bytes=0-3');

    // A player seeks constantly; each ranged read must not cost another API call.
    await app.inject({
      method: 'GET',
      url: `${mediaUrl.pathname}${mediaUrl.search}`,
      headers: { range: 'bytes=500-999' },
    });
    expect(cdn.calls).toHaveLength(2); // two upstream reads…
    expect(mints).toBe(1); // …one minted link
    await app.close();
    store.close();
  });

  it('refuses a wrong or expired signature without touching TorBox', async () => {
    const store = seededStore();
    const cdn = fakeCdn();
    const app = createApp({
      cfg: mediaConfig(),
      store,
      log: createLogger('silent'),
      auth: stubAuth(),
      torbox: fakeTorbox(),
      fetchImpl: cdn.impl,
    });
    const file = `${encodeURIComponent(trackId('torrents', 1, 2))}.flac`;
    const forged = await app.inject({
      method: 'GET',
      url: `/${SECRET}/media/${file}?exp=${Math.floor(Date.now() / 1000) + 600}&sig=not-a-real-signature`,
    });
    expect(forged.statusCode).toBe(403);

    const expired = await app.inject({
      method: 'GET',
      url: `/${SECRET}/media/${file}?exp=1&sig=whatever`,
    });
    expect(expired.statusCode).toBe(403);
    expect(cdn.calls).toHaveLength(0);
    await app.close();
    store.close();
  });
});

describe('operator listing', () => {
  it('lists indexed rows with ids that can be streamed', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/admin/tracks?limit=10` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { count: number; tracks: Array<Record<string, unknown>> };
    expect(body.count).toBe(2);
    expect(body.tracks[0]?.id).toBe(trackId('torrents', 1, 2));
    expect(body.tracks[0]?.codec).toBe('flac');
    expect(body.tracks[0]?.probed).toBe(true);
    await app.close();
    store.close();
  });

  it('renders the sample table on the operator page', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/admin` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Sample of the index');
    expect(response.body).toContain(trackId('torrents', 1, 2));
    await app.close();
    store.close();
  });
});

describe('cors and health', () => {
  it('answers preflight without requiring anything', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'OPTIONS', url: `/${SECRET}/search` });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-expose-headers']).toContain('retry-after');
    await app.close();
    store.close();
  });

  it('reports what it holds without exposing anything secret', async () => {
    const store = seededStore();
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: `/${SECRET}/health` });
    const body = response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.tracks).toBe(2);
    expect(body.lossless).toBe(1);
    expect(body.atmos).toBe(1);
    await app.close();
    store.close();
  });
});
