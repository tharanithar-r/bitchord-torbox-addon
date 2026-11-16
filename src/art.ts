/**
 * Album art, taken from the files themselves.
 *
 * A BitChord search row carries `artworkURL`, and without one the player has no
 * poster: a YouTube row gets its thumbnail from YouTube, an addon row only gets
 * what the addon sends. TorBox holds files, not artwork, so the only honest
 * source is the picture embedded in the audio — a FLAC PICTURE block or an MP4
 * `covr` atom, both of which are already at the front of the file the prober
 * reads.
 *
 * Deliberately bounded: a picture is stored only when it arrived inside the
 * head that was read anyway, so art costs no extra request and an oversized
 * cover is skipped rather than fetched.
 */
export type Cover = { mime: string; bytes: Uint8Array };

/** Larger covers are skipped: the player scales them down anyway. */
export const MAX_COVER_BYTES = 2 * 1024 * 1024;

export function extractCover(buf: Uint8Array): Cover | null {
  const flac = extractFlacPicture(buf);
  if (flac) return flac;
  return extractMp4Cover(buf);
}

/** FLAC: walk metadata blocks to block type 6 and parse its PICTURE layout. */
export function extractFlacPicture(buf: Uint8Array): Cover | null {
  if (buf.length < 8) return null;
  const magic = String.fromCharCode(buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0, buf[3] ?? 0);
  if (magic !== 'fLaC') return null;

  let pos = 4;
  while (pos + 4 <= buf.length) {
    const header = buf[pos] ?? 0;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = ((buf[pos + 1] ?? 0) << 16) | ((buf[pos + 2] ?? 0) << 8) | (buf[pos + 3] ?? 0);
    const body = pos + 4;
    if (body + length > buf.length) return null;
    if (type === 6) return parseFlacPictureBlock(buf.subarray(body, body + length));
    if (last) return null;
    pos = body + length;
  }
  return null;
}

function parseFlacPictureBlock(block: Uint8Array): Cover | null {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  try {
    let pos = 4; // picture type
    const mimeLength = view.getUint32(pos);
    pos += 4;
    if (pos + mimeLength > block.length) return null;
    const mime = new TextDecoder().decode(block.subarray(pos, pos + mimeLength)) || 'image/jpeg';
    pos += mimeLength;
    const descriptionLength = view.getUint32(pos);
    pos += 4 + descriptionLength;
    pos += 16; // width, height, depth, colours
    const dataLength = view.getUint32(pos);
    pos += 4;
    if (dataLength <= 0 || dataLength > MAX_COVER_BYTES) return null;
    if (pos + dataLength > block.length) return null; // cover sat outside the read
    return { mime: normaliseMime(mime), bytes: block.subarray(pos, pos + dataLength) };
  } catch {
    return null;
  }
}

/** MP4/M4A: `moov/udta/meta/ilst/covr` holds a `data` atom whose payload is the image. */
export function extractMp4Cover(buf: Uint8Array): Cover | null {
  if (buf.length < 12) return null;
  const type = String.fromCharCode(buf[4] ?? 0, buf[5] ?? 0, buf[6] ?? 0, buf[7] ?? 0);
  if (type !== 'ftyp') return null;

  const coverIndex = indexOfAscii(buf, 'covr');
  if (coverIndex < 0) return null;
  const dataIndex = indexOfAscii(buf, 'data', coverIndex);
  if (dataIndex < 0) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const atomSize = view.getUint32(dataIndex - 4);
  if (atomSize < 16 || dataIndex - 4 + atomSize > buf.length) return null;
  // `data` atom: 4 bytes type indicator (13 = JPEG, 14 = PNG) + 4 bytes locale.
  const kind = view.getUint32(dataIndex + 4);
  const start = dataIndex + 12;
  const end = dataIndex - 4 + atomSize;
  if (end <= start) return null;
  const bytes = buf.subarray(start, end);
  if (bytes.byteLength > MAX_COVER_BYTES) return null;
  const mime = kind === 14 ? 'image/png' : kind === 13 ? 'image/jpeg' : sniffImageMime(bytes);
  return { mime, bytes };
}

function sniffImageMime(bytes: Uint8Array): string {
  if ((bytes[0] ?? 0) === 0x89 && bytes[1] === 0x50) return 'image/png';
  if ((bytes[0] ?? 0) === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

function normaliseMime(mime: string): string {
  const value = mime.trim().toLowerCase();
  if (value === 'image/jpg' || value === '') return 'image/jpeg';
  return value.startsWith('image/') ? value : `image/${value}`;
}

function indexOfAscii(buf: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  for (let i = Math.max(0, from); i <= buf.length - needle.length; i++) {
    if (buf[i] !== first) continue;
    let hit = true;
    for (let j = 1; j < needle.length; j++) {
      if (buf[i + j] !== needle.charCodeAt(j)) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** A stable key for an album's art, so every track in it shares one image. */
export function artKeyFor(artist: string, album: string): string {
  const basis = `${artist.trim().toLowerCase()}|${album.trim().toLowerCase()}`;
  let hash = 0;
  for (let i = 0; i < basis.length; i++) {
    hash = (hash * 31 + basis.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(7, '0');
}

export function extensionForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}
