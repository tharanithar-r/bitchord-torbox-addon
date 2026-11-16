import type { Logger } from 'pino';
import type { Store, TrackRow } from '../db.js';
import { LOSSLESS_FORMATS } from '../parse.js';
import type { TorBoxClient } from '../torbox.js';
import { ALBUM_KEYS, ARTIST_KEYS, TITLE_KEYS, pickTag, probeUrl } from './audio.js';

/**
 * Filling the index in with what the files actually are.
 *
 * Indexing can only guess from a file name. This worker opens each file's head
 * once and replaces the guess with measurements: real sample rate and bit depth
 * (which is what makes a "Hi-Res" row true), the real duration (BitChord refuses a
 * mid-song swap whose runtime differs by more than two seconds), embedded tags
 * (better titles and artists than a ripped file name), and the codec that decides
 * whether a file is a lossless offer or a Dolby one.
 *
 * Budgeted deliberately: one small ranged read per file, `batchSize` files per run,
 * and a failure is recorded rather than retried in a loop.
 */
export class Prober {
  constructor(
    private readonly store: Store,
    private readonly torbox: TorBoxClient,
    private readonly log: Logger,
    private readonly options: { maxBytes: number } = { maxBytes: 512 * 1024 },
  ) {}

  async runBatch(limit: number): Promise<{ probed: number; failed: number }> {
    const candidates = this.store.tracksNeedingProbe(limit);
    let probed = 0;
    let failed = 0;
    for (const track of candidates) {
      if (await this.probe(track)) probed += 1;
      else failed += 1;
    }
    if (candidates.length > 0) this.log.info({ probed, failed }, 'probe batch finished');
    return { probed, failed };
  }

  async probe(track: TrackRow): Promise<boolean> {
    try {
      const url = await this.torbox.requestLink(track.kind, track.itemId, track.fileId);
      const head = await probeUrl(url, { maxBytes: this.options.maxBytes });
      if (!head) {
        this.store.recordProbe(track.id, {
          codec: null,
          container: null,
          sampleRate: null,
          bitDepth: null,
          durationSec: null,
          isrc: null,
          lossless: track.lossless,
          atmos: track.atmos,
          playable: track.playable,
          note: 'unreadable head',
        });
        return false;
      }
      const codec = head.codec;
      const lossless = LOSSLESS_FORMATS.has(codec);
      const atmos = codec === 'eac3-joc';
      const title = pickTag(head.tags, TITLE_KEYS);
      const artist = pickTag(head.tags, ARTIST_KEYS);
      const album = pickTag(head.tags, ALBUM_KEYS);
      this.store.recordProbe(track.id, {
        codec,
        container: head.container,
        sampleRate: head.sampleRate ?? null,
        bitDepth: head.bitDepth ?? null,
        durationSec: head.durationSec ?? null,
        isrc: head.isrc ?? null,
        lossless,
        atmos,
        playable: head.playable,
        note: head.playable ? null : `unsupported codec ${codec}`,
        title: title ? stripTrackPrefix(title) : undefined,
        artist,
        album,
      });
      return true;
    } catch (error) {
      this.store.recordProbe(track.id, {
        codec: null,
        container: null,
        sampleRate: null,
        bitDepth: null,
        durationSec: null,
        isrc: null,
        lossless: track.lossless,
        atmos: track.atmos,
        playable: track.playable,
        note: `probe failed: ${(error as Error).message.slice(0, 120)}`,
      });
      return false;
    }
  }
}

/** Tags sometimes carry `01 Title`; the number belongs in `trackNo`, not the title. */
function stripTrackPrefix(title: string): string {
  return title.replace(/^\s*\d{1,3}\s*[-._)]\s*/, '').trim();
}
