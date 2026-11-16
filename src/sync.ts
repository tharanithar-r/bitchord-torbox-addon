import type { Logger } from 'pino';
import {
  KINDS,
  type Kind,
  type Store,
  trackId,
} from './db.js';
import {
  formatOfFile,
  isIndexableAudio,
  parseFileName,
  parseReleaseName,
  searchableTitle,
} from './parse.js';
import type { TorBoxClient, TorBoxItem } from './torbox.js';

/**
 * Walking the account into the index.
 *
 * The whole library is the catalogue, so this is the step that turns a debrid
 * account into something searchable. It is idempotent on purpose: a page can be
 * re-walked after a crash, and a re-walk never overwrites what a probe has already
 * learned about a file (see {@link Store.upsertTrack}).
 */
export type SyncResult = { kind: Kind; items: number; tracks: number; done: boolean };

export class Sync {
  constructor(
    private readonly store: Store,
    private readonly torbox: TorBoxClient,
    private readonly log: Logger,
  ) {}

  /** One page per kind, so a huge account never blocks a request for long. */
  async walkAll(pageSize = 100): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const kind of KINDS) {
      try {
        results.push(await this.walkPage(kind, pageSize));
      } catch (error) {
        this.log.warn({ kind, err: (error as Error).message }, 'sync page failed');
        results.push({ kind, items: 0, tracks: 0, done: false });
      }
    }
    return results;
  }

  async walkPage(kind: Kind, pageSize = 100): Promise<SyncResult> {
    const { cursor } = this.store.cursor(kind);
    const offset = cursor > 0 ? cursor : 0;
    const items = await this.torbox.list(kind, { offset, limit: pageSize, files: true });
    let tracks = 0;
    for (const [index, item] of items.entries()) {
      tracks += this.indexItem(kind, item, offset + index);
    }
    const done = items.length < pageSize;
    this.store.setCursor(kind, done ? 0 : offset + items.length, done);
    if (items.length > 0) {
      this.log.info({ kind, offset, items: items.length, tracks, done }, 'synced page');
    }
    return { kind, items: items.length, tracks, done };
  }

  /** Index one item by id — the path used after an added release. */
  async syncItem(kind: Kind, itemId: number): Promise<number> {
    const item = await this.torbox.item(kind, itemId);
    if (!item) return 0;
    return this.indexItem(kind, item, null);
  }

  /**
   * Turn one download into track rows.
   *
   * The release name supplies artist and album (`Artist - Album (2016) [FLAC]`),
   * the file name supplies the track title and its number. A claim of lossless
   * resolution in the release name is **not** trusted here — only the format and,
   * later, the prober decide that.
   */
  private indexItem(kind: Kind, item: TorBoxItem, seq: number | null): number {
    const itemId = Number(item.id);
    if (!Number.isFinite(itemId) || itemId <= 0) return 0;
    const name = String(item.name ?? '');
    const release = parseReleaseName(name);
    this.store.upsertItem({
      kind,
      itemId,
      name,
      hash: item.hash ? String(item.hash).toLowerCase() : null,
      sizeBytes: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
      addedAt: item.created_at ? Math.floor(Date.parse(item.created_at) / 1000) || null : null,
    });

    let indexed = 0;
    for (const [fileIndex, file] of (item.files ?? []).entries()) {
      const fileId = Number(file.id);
      const shortName = String(file.short_name ?? file.name ?? '');
      if (!Number.isFinite(fileId) || shortName === '') continue;
      if (!isIndexableAudio(shortName, file.mimetype)) continue;

      const parsed = parseFileName(shortName);
      const format = formatOfFile(shortName);
      const title = searchableTitle(parsed.title) || parsed.title;
      this.store.upsertTrack({
        id: trackId(kind, itemId, fileId),
        kind,
        itemId,
        fileId,
        title,
        artist: release.artist,
        album: release.album,
        discNo: parsed.discNo ?? null,
        trackNo: parsed.trackNo ?? null,
        seq: seq === null ? fileIndex : seq * 1000 + fileIndex,
        format,
        codec: null,
        container: null,
        sampleRate: null,
        bitDepth: null,
        durationSec: null,
        isrc: null,
        sizeBytes: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
        // Only a format that settles it: `m4a` could be ALAC or AAC.
        lossless: ['flac', 'alac', 'wav', 'aiff', 'ape', 'wv', 'dsf', 'dff'].includes(format),
        // Immersive mixes are only claimed after the prober has seen E-AC-3 JOC.
        atmos: false,
        playable: true,
      });
      indexed += 1;
    }
    return indexed;
  }
}
