import type { Logger } from 'pino';
import { parseTrackId, type Store, type TrackRow } from '../db.js';
import type { Prober } from '../probe/worker.js';
import { extensionFor } from '../media.js';
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
  /**
   * Present when audio is served through this addon (MEDIA_PROXY=1). Then no TorBox
   * link is minted here at all: the answer points at our own signed route, which
   * mints one at fetch time. That also makes this answer instant.
   */
  media?: { url(id: string, ext: string): string };
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
    // Never block the player on a header read. Probing costs a link mint plus a
    // ranged fetch — up to fifteen seconds on a slow CDN — and the player shows that
    // whole wait as "loading". So the probe is started and left to finish: this
    // answer describes the file from its extension, and the next play is measured.
    void deps.prober.probe(track).catch((error: unknown) => {
      deps.log.debug({ id, err: String(error).slice(0, 120) }, 'inline probe failed');
    });
  }

  if (deps.media) {
    const ext = extensionFor({ codec: track.codec, format: track.format });
    return { status: 200, headers: {}, body: streamBody(track, deps.media.url(track.id, ext)) };
  }

  let url = cachedLink(deps.cache, track.id);
  if (!url) {
    try {
      url = await deps.torbox.requestLink(track.kind, track.itemId, track.fileId);
      if (!url.startsWith('https://')) {
        // Android blocks cleartext HTTP, which reaches the player as a silent stall.
        deps.log.warn({ id, host: safeHost(url) }, 'TorBox returned a non-HTTPS link');
      }
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

/** A link already minted for this track, or a fresh one, remembered for reuse. */
export async function linkFor(
  cache: LinkCache,
  id: string,
  mint: () => Promise<string>,
): Promise<string> {
  const hit = cachedLink(cache, id);
  if (hit) return hit;
  const url = await mint();
  cache.set(id, { url, at: Date.now() });
  return url;
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
  const codec = track.codec ?? codecFromFormat(track.format, track.lossless);
  const body: Record<string, unknown> = {
    url,
    format: track.atmos ? 'eac3-joc' : track.format,
    quality: qualityLabel(track),
    // Omitted entirely when nothing can name it — an absent codec is "unknown",
    // which is honest; a wrong one is what breaks selection.
    ...(codec ? { codec } : {}),
    container: track.container ?? containerFor(codec ?? track.format, track.format),
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

/**
 * The codec an extension can name on its own.
 *
 * `m4a` deliberately yields `undefined`: it is AAC or ALAC and only the file
 * settles which, so claiming one would be the "lossless label on a lossy URL" the
 * docs warn about.
 */
export function codecFromFormat(format: string, lossless = false): string | undefined {
  switch (format) {
    case 'flac':
    case 'alac':
    case 'wav':
    case 'aiff':
    case 'ape':
    case 'wv':
    case 'dsf':
    case 'dff':
    case 'mp3':
    case 'aac':
    case 'ogg':
    case 'opus':
      return format;
    case 'm4a':
      return undefined;
    default:
      return lossless ? 'flac' : undefined;
  }
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

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
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
