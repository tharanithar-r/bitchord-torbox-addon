/**
 * Reading the truth out of the first bytes of a file.
 *
 * The BitChord docs are explicit that a lossless label on a lossy URL does not
 * create a lossless badge — the app checks what it decodes. This module is how
 * the addon knows what it is about to serve: real sample rate, real bit depth,
 * real duration, and the embedded tags (title/artist/album/ISRC) that make
 * matching and the "Stats for nerds" screen honest.
 *
 * Two constraints shape all of it:
 *
 *  - **Small reads.** A FLAC's Vorbis comment sits at the front, but album art is
 *    a PICTURE block that can be megabytes. Blocks are walked by their headers,
 *    so art is skipped rather than downloaded — the same trap another Eclipse
 *    addon hit as "tags exceed the safe read limit".
 *  - **Never throw at the caller.** A file that cannot be described is a file
 *    the index leaves alone; a probe that throws would take a request with it.
 */

export type ProbeResult = {
  container: 'flac' | 'mp4' | 'matroska' | 'wav' | 'aiff' | 'ogg' | 'mpeg' | 'unknown';
  /** Codec in BitChord's vocabulary: flac, alac, aac, mp3, wav, aiff, eac3-joc… */
  codec: string;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  durationSec?: number;
  isrc?: string;
  tags: Record<string, string>;
  /** False for things BitChord cannot play (TrueHD, DTS, video-only). */
  playable: boolean;
};

const EMPTY_TAGS: Record<string, string> = {};

function result(partial: Partial<ProbeResult> & Pick<ProbeResult, 'container' | 'codec'>): ProbeResult {
  return { tags: EMPTY_TAGS, playable: true, ...partial };
}

/** Container sniffing by magic bytes; the URL's extension is not trustworthy. */
export function detectContainer(buf: Uint8Array): ProbeResult['container'] {
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...buf.subarray(offset, offset + length));
  if (buf.length < 12) return 'unknown';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(4, 4) === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'matroska';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) return 'aiff';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] ?? 0) >= 0xe0)) return 'mpeg';
  return 'unknown';
}

// ── FLAC ────────────────────────────────────────────────────────────────────

/**
 * FLAC metadata block walking.
 *
 * STREAMINFO gives sample rate, bit depth, channels and the total sample count
 * (so duration needs no decoding), and the Vorbis comment gives the tags —
 * including ISRC, which is what makes an exact re-match possible. PICTURE blocks
 * are stepped over by length, never read.
 */
export function parseFlac(buf: Uint8Array): ProbeResult | null {
  if (buf.length < 42 || detectContainer(buf) !== 'flac') return null;
  let pos = 4;
  let info: { sampleRate?: number; bitDepth?: number; channels?: number; totalSamples?: number } =
    {};
  const tags: Record<string, string> = {};
  let isrc: string | undefined;

  while (pos + 4 <= buf.length) {
    const header = buf[pos] ?? 0;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = ((buf[pos + 1] ?? 0) << 16) | ((buf[pos + 2] ?? 0) << 8) | (buf[pos + 3] ?? 0);
    const body = pos + 4;
    if (body + length > buf.length) break; // truncated read: keep what we have

    if (type === 0 && length >= 18) {
      info = readStreamInfo(buf.subarray(body, body + length));
    } else if (type === 4) {
      Object.assign(tags, readVorbisComment(buf.subarray(body, body + length)));
      const candidate = pickTag(tags, ['ISRC']);
      if (candidate && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(candidate)) isrc = candidate.toUpperCase();
    }
    if (last) break;
    pos = body + length;
  }

  const durationSec =
    info.sampleRate && info.totalSamples ? info.totalSamples / info.sampleRate : undefined;

  return result({
    container: 'flac',
    codec: 'flac',
    sampleRate: info.sampleRate,
    bitDepth: info.bitDepth,
    channels: info.channels,
    durationSec,
    isrc,
    tags,
  });
}

function readStreamInfo(block: Uint8Array): {
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  totalSamples?: number;
} {
  if (block.length < 18) return {};
  let packed = 0n;
  for (let i = 10; i < 18; i++) packed = (packed << 8n) | BigInt(block[i] ?? 0);
  const sampleRate = Number(packed >> 44n);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitDepth = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);
  return {
    sampleRate: sampleRate > 0 ? sampleRate : undefined,
    bitDepth: bitDepth > 0 ? bitDepth : undefined,
    channels,
    totalSamples: totalSamples > 0 ? totalSamples : undefined,
  };
}

/** Little-endian Vorbis comment: vendor, then `KEY=value` pairs. */
export function readVorbisComment(block: Uint8Array): Record<string, string> {
  const tags: Record<string, string> = {};
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  try {
    let pos = 0;
    const vendorLength = view.getUint32(pos, true);
    pos += 4 + vendorLength;
    const count = view.getUint32(pos, true);
    pos += 4;
    for (let i = 0; i < count && pos + 4 <= block.length; i++) {
      const length = view.getUint32(pos, true);
      pos += 4;
      if (pos + length > block.length) break;
      const entry = new TextDecoder().decode(block.subarray(pos, pos + length));
      pos += length;
      const eq = entry.indexOf('=');
      if (eq < 1) continue;
      const key = entry.slice(0, eq).toUpperCase();
      const value = entry.slice(eq + 1);
      if (!(key in tags)) tags[key] = value;
    }
  } catch {
    // A malformed comment block costs tags, not the probe.
  }
  return tags;
}

/** First non-empty value among the spellings different taggers use for one field. */
export function pickTag(tags: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = tags[key] ?? tags[key.toUpperCase()];
    if (value && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export const TITLE_KEYS = ['TITLE', 'TIT2', '©nam'];
export const ARTIST_KEYS = ['ARTIST', 'ALBUMARTIST', 'TPE1', 'aART', '©ART'];
export const ALBUM_KEYS = ['ALBUM', 'TALB', '©alb'];
export const TRACK_KEYS = ['TRACKNUMBER', 'TRCK', 'trkn'];
export const DISC_KEYS = ['DISCNUMBER', 'TPOS', 'disk'];
export const DATE_KEYS = ['DATE', 'YEAR', 'TDRC', '©day'];

// ── MP4 / M4A ───────────────────────────────────────────────────────────────

type Box = { type: string; start: number; bodyStart: number; bodyEnd: number };

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst']);

export function iterateBoxes(buf: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      buf[pos + 4] ?? 0,
      buf[pos + 5] ?? 0,
      buf[pos + 6] ?? 0,
      buf[pos + 7] ?? 0,
    );
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      const big = view.getBigUint64(pos + 8);
      size = Number(big > 2147483647n ? 2147483647n : big);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) break;
    boxes.push({ type, start: pos, bodyStart: pos + header, bodyEnd: Math.min(end, pos + size) });
    pos += size;
  }
  return boxes;
}

/**
 * MP4/M4A: `moov` for the audio sample entry (alac vs aac vs ec-3), `mvhd` for
 * duration, `ilst` for the tags.
 */
export function parseMp4(buf: Uint8Array): ProbeResult | null {
  if (detectContainer(buf) !== 'mp4') return null;
  let codec = 'unknown';
  let sampleRate: number | undefined;
  let bitDepth: number | undefined;
  let channels: number | undefined;
  let durationSec: number | undefined;
  const tags: Record<string, string> = {};

  const root = iterateBoxes(buf, 0, buf.length);
  const moov = root.find((b) => b.type === 'moov');
  if (moov) {
    walkMp4(buf, moov.bodyStart, moov.bodyEnd, (box) => {
      if (box.type === 'mvhd') {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const version = buf[box.bodyStart] ?? 0;
        if (version === 1 && box.bodyStart + 32 <= box.bodyEnd) {
          const timescale = view.getUint32(box.bodyStart + 20);
          const duration = Number(view.getBigUint64(box.bodyStart + 24));
          if (timescale > 0) durationSec = duration / timescale;
        } else if (box.bodyStart + 20 <= box.bodyEnd) {
          const timescale = view.getUint32(box.bodyStart + 12);
          const duration = view.getUint32(box.bodyStart + 16);
          if (timescale > 0) durationSec = duration / timescale;
        }
      } else if (box.type === 'stsd') {
        const entry = iterateBoxes(buf, box.bodyStart + 8, box.bodyEnd)[0];
        if (entry) {
          const boxType = entry.type;
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          if (boxType === 'alac' || boxType === 'mp4a' || boxType === 'ec-3' || boxType === 'ac-3') {
            codec = boxType === 'mp4a' ? 'aac' : boxType === 'ec-3' ? 'eac3' : boxType;
            // AudioSampleEntry after its 8-byte size/type header: 6 reserved + 2
            // data-ref, then channelcount at +16, sample size at +18 and the
            // sample rate as 16.16 fixed point at +24.
            if (entry.bodyStart + 28 <= entry.bodyEnd) {
              channels = view.getUint16(entry.bodyStart + 16);
              bitDepth = view.getUint16(entry.bodyStart + 18);
              sampleRate = Math.round(view.getUint32(entry.bodyStart + 24) / 65536);
            }
            // An `alac` magic cookie nested inside the `mp4a` entry means ALAC.
            const children = iterateBoxes(buf, entry.bodyStart + 28, entry.bodyEnd);
            if (children.some((c) => c.type === 'alac')) codec = 'alac';
          }
        }
      } else if (box.type === 'ilst') {
        for (const item of iterateBoxes(buf, box.bodyStart, box.bodyEnd)) {
          const data = iterateBoxes(buf, item.bodyStart, item.bodyEnd).find((c) => c.type === 'data');
          if (!data || data.bodyStart + 8 > data.bodyEnd) continue;
          const text = new TextDecoder().decode(buf.subarray(data.bodyStart + 8, data.bodyEnd));
          const key = item.type.trim();
          if (key !== '' && text.trim() !== '') tags[key.toUpperCase()] = text.trim();
        }
      }
    });
  }

  const isrc = pickTag(tags, ['ISRC', '----:COM.APPLE.ITUNES:ISRC']);
  const playable = codec !== 'unknown';
  return result({
    container: 'mp4',
    codec,
    sampleRate,
    bitDepth: codec === 'alac' ? bitDepth : undefined,
    channels,
    durationSec,
    isrc,
    tags,
    playable,
  });
}

function walkMp4(
  buf: Uint8Array,
  start: number,
  end: number,
  visit: (box: Box) => void,
  depth = 0,
): void {
  if (depth > 8) return;
  for (const box of iterateBoxes(buf, start, end)) {
    visit(box);
    if (MP4_CONTAINERS.has(box.type)) {
      // `meta` is a full box: four bytes of version/flags before its children.
      walkMp4(buf, box.bodyStart, box.bodyEnd, visit, depth + 1);
    } else if (box.type === 'meta') {
      walkMp4(buf, box.bodyStart + 4, box.bodyEnd, visit, depth + 1);
    }
  }
}

// ── Matroska ────────────────────────────────────────────────────────────────

const MKV_SEGMENT = 0x18538067;
const MKV_INFO = 0x1549a966;
const MKV_TRACKS = 0x1654ae6b;
const MKV_TRACK_ENTRY = 0xae;
const MKV_AUDIO = 0xe1;
const MKV_ATTACHMENTS = 0x1941a469;
const MKV_TAGS = 0x1254c367;
const MKV_CODEC_ID = 0x86;
const MKV_CODEC_PRIVATE = 0x63a2;
const MKV_SAMPLING_FREQUENCY = 0xb5;
const MKV_CHANNELS = 0x9f;
const MKV_BIT_DEPTH = 0x6264;
const MKV_TIMECODE_SCALE = 0x2ad7b1;
const MKV_DURATION = 0x4489;
const MKV_CONTAINERS = new Set([
  MKV_SEGMENT,
  MKV_INFO,
  MKV_TRACKS,
  MKV_TRACK_ENTRY,
  MKV_AUDIO,
  MKV_ATTACHMENTS,
  MKV_TAGS,
]);

function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): { value: number; next: number } {
  const first = buf[pos] ?? 0;
  if (first === 0) return { value: 0, next: pos + 1 };
  let length = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) length++;
  if (length > 8 || pos + length > buf.length) return { value: 0, next: pos + length };
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + (buf[pos + i] ?? 0);
  return { value: value < 0 ? 0 : value, next: pos + length };
}

/**
 * Matroska: enough of EBML to name the audio codec and its parameters.
 *
 * This is what separates "an MKV with a DD+ Atmos track" from "a TrueHD remux
 * BitChord cannot decode" — the difference between an offer and a promise the
 * player cannot keep.
 */
export function parseMkv(buf: Uint8Array): ProbeResult | null {
  if (detectContainer(buf) !== 'matroska') return null;
  let codecId = '';
  let sampleRate: number | undefined;
  let bitDepth: number | undefined;
  let channels: number | undefined;
  let durationSec: number | undefined;
  let timecodeScale = 1_000_000;
  let hasJoc = false;

  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 8) return;
    let pos = start;
    while (pos < end) {
      const id = readVint(buf, pos, true);
      const size = readVint(buf, id.next, false);
      const bodyStart = size.next;
      const bodyEnd = Math.min(end, bodyStart + size.value);
      if (bodyEnd <= bodyStart && size.value !== 0) break;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

      if (MKV_CONTAINERS.has(id.value)) {
        walk(bodyStart, bodyEnd, depth + 1);
      } else if (id.value === MKV_CODEC_ID) {
        codecId = new TextDecoder().decode(buf.subarray(bodyStart, bodyEnd)).replace(/\0/g, '');
      } else if (id.value === MKV_CODEC_PRIVATE) {
        const text = new TextDecoder().decode(buf.subarray(bodyStart, Math.min(bodyEnd, bodyStart + 64)));
        if (/joc/i.test(text)) hasJoc = true;
      } else if (id.value === MKV_SAMPLING_FREQUENCY && bodyEnd - bodyStart >= 4) {
        sampleRate =
          bodyEnd - bodyStart >= 8 ? view.getFloat64(bodyStart) : view.getFloat32(bodyStart);
      } else if (id.value === MKV_CHANNELS && bodyEnd - bodyStart >= 1) {
        channels = readUint(buf.subarray(bodyStart, bodyEnd));
      } else if (id.value === MKV_BIT_DEPTH && bodyEnd - bodyStart >= 1) {
        bitDepth = readUint(buf.subarray(bodyStart, bodyEnd));
      } else if (id.value === MKV_TIMECODE_SCALE) {
        timecodeScale = readUint(buf.subarray(bodyStart, bodyEnd)) || timecodeScale;
      } else if (id.value === MKV_DURATION && bodyEnd - bodyStart >= 4) {
        const raw =
          bodyEnd - bodyStart >= 8 ? view.getFloat64(bodyStart) : view.getFloat32(bodyStart);
        durationSec = (raw * timecodeScale) / 1_000_000_000;
      }
      pos = bodyEnd;
    }
  };
  walk(0, buf.length, 0);

  const codec = codecFromMkvId(codecId, channels, hasJoc);
  const playable = codec === 'flac' || codec === 'alac' || codec === 'eac3-joc';
  return result({
    container: 'matroska',
    codec,
    sampleRate: sampleRate && Number.isFinite(sampleRate) ? Math.round(sampleRate) : undefined,
    bitDepth,
    channels,
    durationSec,
    tags: { CODEC_ID: codecId },
    playable,
  });
}

function readUint(bytes: Uint8Array): number {
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  return value;
}

function codecFromMkvId(codecId: string, channels?: number, hasJoc = false): string {
  switch (codecId) {
    case 'A_FLAC':
      return 'flac';
    case 'A_ALAC':
      return 'alac';
    case 'A_EAC3':
      // A 7.1 bed is the usual signature of a JOC (Atmos) encode; MKV stores no
      // explicit JOC flag, so channels plus an explicit `joc` in CodecPrivate are
      // the only signals available before decoding.
      return hasJoc || (channels ?? 0) >= 8 ? 'eac3-joc' : 'eac3';
    case 'A_AC3':
      return 'ac3';
    case 'A_TRUEHD':
      return 'truehd';
    case 'A_DTS':
      return 'dts';
    case 'A_AAC':
      return 'aac';
    case 'A_OPUS':
      return 'opus';
    case 'A_VORBIS':
      return 'vorbis';
    case 'A_PCM/INT/LIT':
    case 'A_PCM/FLOAT/IEEE':
      return 'wav';
    default:
      return 'unknown';
  }
}

// ── WAV / AIFF ──────────────────────────────────────────────────────────────

export function parseWav(buf: Uint8Array): ProbeResult | null {
  if (detectContainer(buf) !== 'wav') return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitDepth: number | undefined;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = String.fromCharCode(buf[pos] ?? 0, buf[pos + 1] ?? 0, buf[pos + 2] ?? 0, buf[pos + 3] ?? 0);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    pos = body + size + (size % 2);
  }
  const bytesPerSecond = (sampleRate ?? 0) * (channels ?? 0) * ((bitDepth ?? 0) / 8);
  return result({
    container: 'wav',
    codec: 'wav',
    sampleRate,
    bitDepth,
    channels,
    durationSec: bytesPerSecond > 0 && dataSize > 0 ? dataSize / bytesPerSecond : undefined,
  });
}

export function parseAiff(buf: Uint8Array): ProbeResult | null {
  if (detectContainer(buf) !== 'aiff') return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitDepth: number | undefined;
  let frames = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = String.fromCharCode(buf[pos] ?? 0, buf[pos + 1] ?? 0, buf[pos + 2] ?? 0, buf[pos + 3] ?? 0);
    const size = view.getUint32(pos + 4);
    const body = pos + 8;
    if (id === 'COMM' && body + 18 <= buf.length) {
      channels = view.getUint16(body);
      frames = view.getUint32(body + 2);
      bitDepth = view.getUint16(body + 6);
      sampleRate = readExtendedFloat(buf.subarray(body + 8, body + 18));
      break;
    }
    pos = body + size + (size % 2);
  }
  return result({
    container: 'aiff',
    codec: 'aiff',
    sampleRate,
    bitDepth,
    channels,
    durationSec: sampleRate && frames ? frames / sampleRate : undefined,
  });
}

/** AIFF's 80-bit IEEE 754 extended float, used for the sample rate. */
export function readExtendedFloat(bytes: Uint8Array): number | undefined {
  if (bytes.length < 10) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const exponent = view.getUint16(0) & 0x7fff;
  const hi = view.getUint32(2);
  const lo = view.getUint32(6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * 2 ** 32 + lo;
  return mantissa * 2 ** (exponent - 16383 - 63);
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function parseAudioHead(buf: Uint8Array): ProbeResult | null {
  switch (detectContainer(buf)) {
    case 'flac':
      return parseFlac(buf);
    case 'mp4':
      return parseMp4(buf);
    case 'matroska':
      return parseMkv(buf);
    case 'wav':
      return parseWav(buf);
    case 'aiff':
      return parseAiff(buf);
    case 'mpeg': {
      // MP3: only the codec is knowable from the head without a frame walk.
      return result({ container: 'mpeg', codec: 'mp3' });
    }
    case 'ogg': {
      const text = new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 256)));
      return result({ container: 'ogg', codec: /OpusHead/.test(text) ? 'opus' : 'vorbis' });
    }
    default:
      return null;
  }
}

/**
 * Fetch the smallest prefix that answers the question, and describe it.
 *
 * One ranged request, bounded by `maxBytes`, with the body read through a stream
 * so a server that ignores `Range` cannot pull an entire 500 MB album into memory.
 */
/**
 * The smallest prefix of a file, fetched once.
 *
 * Split out of [probeUrl] so a caller that wants both the measurements and the
 * embedded cover — the prober does — pays for one ranged request instead of two.
 */
export async function fetchHead(
  url: string,
  options: {
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<Uint8Array | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetchImpl(url, {
      headers: { ...options.headers, range: `bytes=0-${maxBytes - 1}` },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok && response.status !== 206) return null;
    return await readAtMost(response, maxBytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What is on the end of [url], or null when the head could not be read. */
export async function probeUrl(
  url: string,
  options: {
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<ProbeResult | null> {
  const head = await fetchHead(url, options);
  return head ? parseAudioHead(head) : null;
}

async function readAtMost(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.length - offset);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}
