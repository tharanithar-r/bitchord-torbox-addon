import type { Logger } from 'pino';
import type { Store, TrackRow } from '../db.js';
import type { Sync } from '../sync.js';
import type { TorBoxClient } from '../torbox.js';
import { magnetFor, searchIndexers, type IndexerOptions, type Release } from './indexers.js';

/**
 * Turning "I do not have this" into "I will have this shortly".
 *
 * This is the half of the addon that makes it a catalogue rather than a viewer of
 * whatever was already downloaded. The policy, in order:
 *
 *  1. **Cached first.** `checkcached` decides everything. A release TorBox already
 *     holds is added with `add_only_if_cached`, becomes streamable in seconds, and
 *     costs nothing from the 60/hour uncached budget.
 *  2. **Uncached is opt-in.** A release that is not cached is *skipped* unless
 *     `ACQUIRE_UNCACHED=1`. That is the honest default: a debrid cache for music is
 *     thin, uncached adds are throttled to 60/hour, and a dead torrent would sit in
 *     the account forever.
 *  3. **Guardrails, always.** One album per infohash, a per-hour ceiling, a minimum
 *     seeder count and a maximum album size — the four ways an automatic downloader
 *     gets out of hand.
 *
 * Nothing here ever blocks a request: a miss is answered `404` immediately and the
 * work happens behind it.
 */
export type AcquireConfig = {
  enabled: boolean;
  allowUncached: boolean;
  maxAlbumsPerHour: number;
  minSeeders: number;
  maxAlbumGb: number;
};

export type ProcessOutcome = 'added' | 'cached-added' | 'skipped' | 'failed' | 'empty' | 'budget';

export type AcquireDeps = {
  /** Injected in tests; production uses the free indexers. */
  search?: (query: string, options?: IndexerOptions) => Promise<Release[]>;
};

export class Acquisition {
  /** Timestamps of every add this process has made, for the hourly ceiling. */
  private adds: number[] = [];
  /** Queries already tried inline, so a 3-query search does not become 3 indexer runs. */
  private readonly recent = new Map<string, number>();
  private readonly search: (query: string, options?: IndexerOptions) => Promise<Release[]>;

  constructor(
    private readonly store: Store,
    private readonly torbox: TorBoxClient,
    private readonly sync: Sync,
    private readonly log: Logger,
    private readonly cfg: AcquireConfig,
    deps: AcquireDeps = {},
  ) {
    this.search = deps.search ?? searchIndexers;
  }

  /**
   * A bounded, cached-only attempt made from `/search` itself.
   *
   * This is what makes a song from BitChord's Home screen work: the app only
   * calls `/stream` for a row it was shown, so an addon that answers an empty
   * search has no way to be asked again. Acquiring here means the album is
   * fetched *and indexed* before the search answers, so the row exists.
   *
   * Cached-only and deadline-bounded on purpose: a cached release adds in a
   * second or two, an uncached one is a queue item and not something a search
   * may wait on. Every release that is not cached is queued for the worker.
   */
  async acquireInline(query: string, budgetMs = 4000): Promise<number> {
    if (!this.cfg.enabled) return 0;
    const key = query.trim().toLowerCase();
    if (key.length < 3) return 0;
    const now = Date.now();
    const last = this.recent.get(key) ?? 0;
    // BitChord asks up to three queries per search; without this, one tap would
    // become three indexer runs and three batches of cache checks.
    if (now - last < 10 * 60_000) return 0;
    if (this.budgetLeft() <= 0) return 0;
    this.recent.set(key, now);

    const deadline = now + budgetMs;
    try {
      const releases = await this.search(query, {
        minSeeders: this.cfg.minSeeders,
        maxSizeBytes: this.cfg.maxAlbumGb * 1024 ** 3,
        limit: 10,
        log: this.log,
      });
      const candidates = releases.slice(0, 3);
      if (candidates.length === 0) return 0;

      const cached = await this.torbox.checkCached(
        candidates.map((release) => release.hash),
        { kind: 'torrents' },
      );

      for (const release of candidates) {
        // Whatever cannot be served now is queued, so it can appear later.
        if (!cached[release.hash]) {
          this.store.enqueue({
            hash: release.hash,
            name: release.name,
            sizeBytes: release.sizeBytes,
            seeders: release.seeders,
            source: release.source,
          });
          continue;
        }
        if (Date.now() > deadline) continue;
        const added = await this.torbox.addTorrent(release.magnet, {
          onlyIfCached: true,
          name: release.name,
        });
        this.countAdd();
        const indexed = await this.sync.syncItem('torrents', added.torrentId).catch(() => 0);
        this.store.updateQueue(release.hash, {
          state: 'added',
          itemKind: 'torrents',
          itemId: added.torrentId,
          note: `inline, ${indexed} tracks indexed`,
        });
        if (indexed > 0) {
          this.log.info({ query, indexed }, 'acquired inline for a search');
          return indexed;
        }
      }
    } catch (error) {
      this.log.warn({ query, err: (error as Error).message.slice(0, 120) }, 'inline acquire failed');
    }
    return 0;
  }

  /** Queue plausible releases for a track that was asked for and is not held. */
  async queueForTrack(track: TrackRow): Promise<number> {
    if (!this.cfg.enabled) return 0;
    const query = [track.artist, track.title].filter((p) => p && p.trim() !== '').join(' ').trim();
    if (query.length < 3) return 0;
    const releases = await searchIndexers(query, {
      minSeeders: this.cfg.minSeeders,
      maxSizeBytes: this.cfg.maxAlbumGb * 1024 ** 3,
      limit: 20,
      log: this.log,
    });
    const candidates = releases.slice(0, 3);
    for (const release of candidates) {
      this.store.enqueue({
        hash: release.hash,
        name: release.name,
        sizeBytes: release.sizeBytes,
        seeders: release.seeders,
        source: release.source,
        artist: track.artist,
        album: track.album,
        wantedTitle: track.title,
      });
    }
    if (candidates.length > 0) {
      this.log.info({ query, queued: candidates.length }, 'queued acquisition candidates');
    }
    return candidates.length;
  }

  /** One queue item per call; the worker decides how often to call it. */
  async processOne(): Promise<ProcessOutcome> {
    if (!this.cfg.enabled) return 'skipped';
    const row = this.store.nextQueue();
    if (!row) return 'empty';
    if (this.budgetLeft() <= 0) return 'budget';

    const magnet = magnetFor(row.hash, row.name);
    try {
      const cached = await this.torbox.checkCached([row.hash], { kind: 'torrents', listFiles: true });
      const entry = cached[row.hash];

      if (!entry) {
        if (!this.cfg.allowUncached || (row.seeders ?? 0) < this.cfg.minSeeders) {
          this.store.updateQueue(row.hash, {
            state: 'skipped',
            attempts: row.attempts + 1,
            note: 'not cached on TorBox',
          });
          return 'skipped';
        }
        const added = await this.torbox.addTorrent(magnet, { onlyIfCached: false, name: row.name });
        this.countAdd();
        this.store.updateQueue(row.hash, {
          state: 'added',
          attempts: row.attempts + 1,
          itemKind: 'torrents',
          itemId: added.torrentId,
          note: 'uncached, downloading',
        });
        // Files exist as soon as TorBox has metadata; the prober fills in quality.
        await this.sync.syncItem('torrents', added.torrentId).catch(() => 0);
        this.log.info({ hash: row.hash, torrentId: added.torrentId }, 'added uncached release');
        return 'added';
      }

      const added = await this.torbox.addTorrent(magnet, { onlyIfCached: true, name: row.name });
      this.countAdd();
      const indexed = await this.sync.syncItem('torrents', added.torrentId).catch(() => 0);
      this.store.updateQueue(row.hash, {
        state: 'added',
        attempts: row.attempts + 1,
        itemKind: 'torrents',
        itemId: added.torrentId,
        note: `cached, ${indexed} tracks indexed`,
      });
      this.log.info({ hash: row.hash, torrentId: added.torrentId, indexed }, 'added cached release');
      return 'cached-added';
    } catch (error) {
      const message = (error as Error).message.slice(0, 160);
      this.store.updateQueue(row.hash, {
        state: row.attempts >= 2 ? 'failed' : 'pending',
        attempts: row.attempts + 1,
        note: message,
      });
      this.log.warn({ hash: row.hash, err: message }, 'acquisition failed');
      return 'failed';
    }
  }

  /** How many adds remain in the rolling hour. */
  budgetLeft(): number {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.adds = this.adds.filter((t) => t >= cutoff);
    return this.cfg.maxAlbumsPerHour - this.adds.length;
  }

  private countAdd(): void {
    this.adds.push(Date.now());
  }

  /** Queue a set of releases the probe script or an admin action already found. */
  enqueueMany(releases: Release[]): number {
    for (const release of releases) {
      this.store.enqueue({
        hash: release.hash,
        name: release.name,
        sizeBytes: release.sizeBytes,
        seeders: release.seeders,
        source: release.source,
      });
    }
    return releases.length;
  }
}
