import { describe, expect, it } from 'vitest';
import { Acquisition } from '../src/acquire/queue.js';
import type { Release } from '../src/acquire/indexers.js';
import { Store } from '../src/db.js';
import { createLogger } from '../src/log.js';
import type { Sync } from '../src/sync.js';
import type { TorBoxClient } from '../src/torbox.js';

const RELEASE: Release = {
  hash: 'a'.repeat(40),
  magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
  name: 'Miles Davis - Kind of Blue (1959) [FLAC 24-96]',
  sizeBytes: 400 * 1024 * 1024,
  seeders: 30,
  source: 'knaben',
};

function cfg(overrides: Partial<{ enabled: boolean; allowUncached: boolean }> = {}) {
  return {
    enabled: overrides.enabled ?? true,
    allowUncached: overrides.allowUncached ?? false,
    maxAlbumsPerHour: 6,
    minSeeders: 1,
    maxAlbumGb: 8,
  };
}

describe('inline acquisition from a search', () => {
  it('adds a cached release and reports how many tracks it indexed', async () => {
    const store = Store.open(':memory:');
    let added = 0;
    const torbox = {
      checkCached: async (hashes: string[]) => Object.fromEntries(hashes.map((h) => [h, { name: RELEASE.name }])),
      addTorrent: async () => {
        added += 1;
        return { torrentId: 42, hash: RELEASE.hash };
      },
    } as unknown as TorBoxClient;
    const sync = { syncItem: async () => 12 } as unknown as Sync;

    const acquisition = new Acquisition(store, torbox, sync, createLogger('silent'), cfg(), {
      search: async () => [RELEASE],
    });

    await expect(acquisition.acquireInline('miles davis so what')).resolves.toBe(12);
    expect(added).toBe(1);
    store.close();
  });

  it('queues an uncached release instead of waiting on it', async () => {
    const store = Store.open(':memory:');
    const torbox = {
      checkCached: async () => ({}), // nothing cached
      addTorrent: async () => {
        throw new Error('must not add an uncached release inline');
      },
    } as unknown as TorBoxClient;

    const sync = { syncItem: async () => 0 } as unknown as Sync;
    const acquisition = new Acquisition(store, torbox, sync, createLogger('silent'), cfg(), {
      search: async () => [RELEASE],
    });

    await expect(acquisition.acquireInline('miles davis so what')).resolves.toBe(0);
    expect(store.recentQueue(5)).toHaveLength(1);
    expect(store.recentQueue(5)[0]?.state).toBe('pending');
    store.close();
  });

  it('does not hit the indexers again for the same query within ten minutes', async () => {
    const store = Store.open(':memory:');
    let searches = 0;
    const torbox = { checkCached: async () => ({}) } as unknown as TorBoxClient;
    const sync = { syncItem: async () => 0 } as unknown as Sync;
    const acquisition = new Acquisition(store, torbox, sync, createLogger('silent'), cfg(), {
      search: async () => {
        searches += 1;
        return [RELEASE];
      },
    });

    await acquisition.acquireInline('miles davis so what');
    // BitChord sends up to three queries per search; identical ones must not
    // each become an indexer run.
    await acquisition.acquireInline('Miles Davis So What');
    expect(searches).toBe(1);
    store.close();
  });

  it('does nothing when acquisition is switched off', async () => {
    const store = Store.open(':memory:');
    const acquisition = new Acquisition(
      store,
      {} as TorBoxClient,
      {} as Sync,
      createLogger('silent'),
      cfg({ enabled: false }),
      { search: async () => [RELEASE] },
    );
    await expect(acquisition.acquireInline('anything at all')).resolves.toBe(0);
    store.close();
  });
});
