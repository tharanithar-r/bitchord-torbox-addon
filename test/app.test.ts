import { describe, expect, it } from 'vitest';
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
