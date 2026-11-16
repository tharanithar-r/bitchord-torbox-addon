import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { Sync } from '../src/sync.js';
import type { TorBoxClient, TorBoxItem } from '../src/torbox.js';

/**
 * The walk has one job that is easy to get wrong: finish. Walking a single page per
 * timer tick left a 200-item account indexed as exactly 200 tracks and a larger one
 * taking hours per page, so a paging bug looks like a working addon with a small
 * library. These tests pin the loop, not the HTTP.
 */
function item(id: number, name: string, files: string[]): TorBoxItem {
  return {
    id,
    name,
    hash: `hash-${id}`,
    size: 1000,
    files: files.map((shortName, index) => ({
      id: id * 100 + index,
      short_name: shortName,
      size: 100,
      mimetype: 'audio/flac',
    })),
  };
}

const LIBRARY: TorBoxItem[] = [
  item(1, 'Miles Davis - Kind of Blue (1959) [FLAC 24-96]', [
    '01 - So What.flac',
    '02 - Freddie Freeloader.flac',
  ]),
  item(2, 'Radiohead - In Rainbows (2007) [FLAC]', ['1-01 15 Step.flac', '1-02 Bodysnatchers.flac']),
  item(3, 'Daft Punk - Random Access Memories (2013) [FLAC]', [
    '01 - Give Life Back to Music.flac',
    '02 - The Game of Love.flac',
    'cover.jpg',
  ]),
];

function fakeClient(library: TorBoxItem[]): TorBoxClient {
  return {
    // Only torrents holds anything; usenet and webdl answer empty, so a walk that
    // wrongly crosses kinds would show up as extra rows.
    list: async (kind: string, options: { offset?: number; limit?: number } = {}) => {
      if (kind !== 'torrents') return [];
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 100;
      return library.slice(offset, offset + limit);
    },
    item: async (_kind: string, itemId: number) => library.find((entry) => entry.id === itemId) ?? null,
  } as unknown as TorBoxClient;
}

describe('library walk', () => {
  it('pages until the library is exhausted, not one page per call', async () => {
    const store = Store.open(':memory:');
    const sync = new Sync(store, fakeClient(LIBRARY), createLogger('silent'));

    const results = await sync.walkUntilDone({ pageSize: 2, maxPages: 20 });
    const torrents = results.find((r) => r.kind === 'torrents');
    expect(torrents?.done).toBe(true);
    expect(torrents?.items).toBe(3);

    const stats = store.stats();
    expect(stats.items.torrents).toBe(3);
    // Six audio files across the three releases; the jpg is not music.
    expect(stats.tracks).toBe(6);
    store.close();
  });

  it('derives artist, album, title, disc and track number from the names', async () => {
    const store = Store.open(':memory:');
    const sync = new Sync(store, fakeClient(LIBRARY), createLogger('silent'));
    await sync.walkUntilDone({ pageSize: 10 });

    const rows = store.searchTracks(['bodysnatchers']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Bodysnatchers',
      artist: 'Radiohead',
      album: 'In Rainbows',
      discNo: 1,
      trackNo: 2,
      format: 'flac',
      lossless: true,
      atmos: false,
    });
    store.close();
  });

  it('stops at the page budget and reports the walk as unfinished', async () => {
    const store = Store.open(':memory:');
    const sync = new Sync(store, fakeClient(LIBRARY), createLogger('silent'));
    const results = await sync.walkUntilDone({ pageSize: 1, maxPages: 1 });
    expect(results.find((r) => r.kind === 'torrents')?.done).toBe(false);
    store.close();
  });

  it('resumes from the stored cursor on the next pass', async () => {
    const store = Store.open(':memory:');
    const sync = new Sync(store, fakeClient(LIBRARY), createLogger('silent'));
    await sync.walkUntilDone({ pageSize: 2, maxPages: 1 }); // first page only
    expect(store.stats().items.torrents).toBe(2);
    await sync.walkUntilDone({ pageSize: 2, maxPages: 20 }); // resume
    expect(store.stats().items.torrents).toBe(3);
    store.close();
  });
});
