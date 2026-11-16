import type { Logger } from 'pino';
import { parseTrackId, type Store, type TrackRow } from '../db.js';
import type { Prober } from '../probe/worker.js';
import { TorBoxError, type TorBoxClient } from '../torbox.js';
import { normalizeTier } from './search.js';

/**
 * Handing the player a URL.
 *
 * Four decisions worth naming:
 *
 *  - **The CDN URL is handed over directly.** It is presigned by TorBox, valid for
 *    three hours to *start* a transfer, and needs no header the player could not
 *    send. Proxying the audio would cost bandwidth and break seeking for no gain.
 *  - **Probe before answering.** A row that has never been opened gets its head
 *    read here, so the `codec`/`sampleRate`/`bitDepth` in the answer describe the
 *    bytes rather than the file name.
 *  - **Cache for four minutes.** BitChord reuses a stream answer for five, and a
 *    long track that is paused and resumed asks again — TorBox links outlive that
 *    by hours, so the cache only saves minting calls.
 *  - **A miss is a 404, and starts acquisition.** The docs are explicit that 404 is
 *    "not in this addon" and moves resolution on cleanly; there is no notice channel
 *    in BitChord, so the queue works silently behind the miss.
 */
export type LinkCache = Map<string, { url: string; at: number }>;

const LINK_TTL_MS = 4 * 60 * 1000;

export type StreamDeps = {
  store: Store;
  torbox?: TorBoxClient;
  prober?: Prober;
  log: Logger;
  cache: LinkCache;
  onMiss?: (track: TrackRow) => void;
};

export type StreamAnswer = {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export async function resolveStream(
  deps: StreamDeps,
  id: string,
  params: { quality?: string; atmos?: string },
): Promise<StreamAnswer> {
  const parsed = parseTrackId(id);
  if (!parsed) return { status: 404, headers: {}, body: { error: 'Unknown track id' } };

  let track = deps.store.getTrack(id);
  if (!track) return { status: 404, headers: {}, body: { error: 'Not held by this addon' } };
  if (!track.playable) {
    return { status: 404, headers: {}, body: { error: `Cannot play ${track.codec ?? track.format}` } };
  }
  if (!deps.torbox) {
    return { status: 503, headers: {}, body: { error: 'TorBox key not configured on this addon' } };
  }

  // The tier decides nothing about *whether* to play — only what to prefer — but a
  // metered (LOW) request is answered with a miss so the next source can serve it.
  const tier = normalizeTier(params.quality);
  if (tier === 'none') {
    return { status: 404, headers: {}, body: { error: 'No low-bandwidth rendition in this addon' } };
  }

  if (track.probedAt === null && deps.prober) {
    const ok = await deps.prober.probe(track);
    const refreshed = deps.store.getTrack(id);
    if (refreshed) track = refreshed;
    if (!ok) deps.log.debug({ id }, 'probe did not settle this file');
    if (!track.playable) {
      return { status: 404, headers: {}, body: { error: `Cannot play ${track.codec ?? track.format}` } };
    }
  }

  let url = cachedLink(deps.cache, track.id);
  if (!url) {
    try {
      url = await deps.torbox.requestLink(track.kind, track.itemId, track.fileId);
      deps.cache.set(track.id, { url, at: Date.now() });
    } catch (error) {
      if (error instanceof TorBoxError) {
        const headers: Record<string, string> = {};
        if (error.retryAfterMs) headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1000));
        deps.log.warn({ id, code: error.code }, 'could not mint a stream link');
        return { status: error.status === 429 ? 429 : 502, headers, body: { error: error.message } };
      }
      return { status: 502, headers: {}, body: { error: 'TorBox request failed' } };
    }
  }

  return { status: 200, headers: {}, body: streamBody(track, url) };
}

function cachedLink(cache: LinkCache, id: string): string | null {
  const hit = cache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > LINK_TTL_MS) {
    cache.delete(id);
    return null;
  }
  return hit.url;
}

/** The `/stream` answer, with the routing fields filled in from measurements. */
export function streamBody(track: TrackRow, url: string): Record<string, unknown> {
  const codec = track.codec ?? (track.lossless ? 'flac' : track.format);
  const body: Record<string, unknown> = {
    url,
    format: track.atmos ? 'eac3-joc' : track.format,
    quality: qualityLabel(track),
    codec,
    container: track.container ?? containerFor(codec, track.format),
    manifest: 'none',
    encrypted: false,
    // TorBox keeps a link open for three hours to start a transfer; advertising
    // less than that is what a client needs to know to refresh in time.
    expiresAt: Math.floor(Date.now() / 1000) + 2.5 * 60 * 60,
  };
  if (track.sampleRate) body.sampleRate = track.sampleRate;
  if (track.bitDepth && track.lossless) body.bitDepth = track.bitDepth;
  if (track.atmos) {
    body.audioMode = 'DOLBY_ATMOS';
    body.audioModes = ['DOLBY_ATMOS'];
  }
  if (track.isrc) body.isrc = track.isrc;
  return body;
}

export function containerFor(codec: string, format: string): string {
  switch (codec) {
    case 'flac':
      return 'flac';
    case 'alac':
    case 'aac':
    case 'm4a':
    case 'eac3':
    case 'eac3-joc':
      return 'mp4';
    case 'wav':
      return 'wav';
    case 'aiff':
      return 'aiff';
    case 'mp3':
      return 'mp3';
    case 'opus':
    case 'vorbis':
      return 'ogg';
    default:
      return format === 'unknown' ? 'unknown' : format;
  }
}

export function qualityLabel(track: TrackRow): string {
  if (track.atmos) return 'Dolby Atmos';
  if (track.lossless) {
    const parts = ['Lossless'];
    if (track.bitDepth) parts.push(`${track.bitDepth}-bit`);
    if (track.sampleRate) {
      const khz = track.sampleRate / 1000;
      parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`);
    }
    return parts.join(' · ');
  }
  return (track.codec ?? track.format).toUpperCase();
}
