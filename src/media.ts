import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Our own signed media route — the fallback the BitChord docs prescribe.
 *
 * Why it exists at all: `url` in a `/stream` answer is required to be an
 * "absolute, directly playable media URL". A TorBox presigned link is absolute and
 * HTTPS, but it is *extensionless* (`/dld/<uuid>?token=<uuid>`), which is the exact
 * shape the docs call out — and an extensionless URL gives the player nothing to
 * infer the container from, however well the JSON declares it.
 *
 * Serving the bytes ourselves fixes three things at once: the path ends in the real
 * extension, we set `Content-Type`, and `Range`/`Accept-Ranges` are ours to get
 * right. The cost is bandwidth through this box instead of device→CDN directly,
 * which is why it is off by default and switched on when the direct URL does not
 * work.
 *
 * The signature is the docs' own scheme: `HMAC-SHA256(MEDIA_SECRET, "<id>.<exp>")`,
 * base64url, checked with a constant-time compare. The media route must never
 * require BitChord's headers — the player does not send them.
 */
export function hasMediaSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= 16;
}

export function mediaSecretOrRandom(secret: string | undefined): string {
  return hasMediaSecret(secret) ? secret : randomBytes(32).toString('hex');
}

export function signMedia(id: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
}

export function mediaUrl(input: {
  host: string;
  basePath: string;
  id: string;
  ext: string;
  exp: number;
  secret: string;
}): string {
  const sig = signMedia(input.id, input.exp, input.secret);
  const file = `${encodeURIComponent(input.id)}.${input.ext}`;
  return `https://${input.host}/${input.basePath}/media/${file}?exp=${input.exp}&sig=${sig}`;
}

/** Whether a request on the media route may proceed. */
export function verifyMedia(input: {
  id: string;
  exp: string | undefined;
  sig: string | undefined;
  secret: string;
  now?: number;
}): { ok: true } | { ok: false; reason: 'expired' | 'bad_signature' } {
  const now = input.now ?? Date.now() / 1000;
  const exp = Number(input.exp);
  if (!Number.isFinite(exp) || exp < now) return { ok: false, reason: 'expired' };
  if (!input.sig) return { ok: false, reason: 'bad_signature' };
  const want = Buffer.from(signMedia(input.id, exp, input.secret));
  const got = Buffer.from(String(input.sig));
  if (got.length !== want.length) return { ok: false, reason: 'bad_signature' };
  return timingSafeEqual(got, want) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/** The extension to put on a media URL, from what the prober measured. */
export function extensionFor(track: { codec: string | null; format: string }): string {
  const codec = track.codec ?? track.format;
  switch (codec) {
    case 'flac':
    case 'alac':
    case 'wav':
    case 'aiff':
    case 'mp3':
    case 'aac':
    case 'ogg':
    case 'opus':
    case 'eac3-joc':
      return codec === 'eac3-joc' ? 'm4a' : codec;
    case 'm4a':
    case 'eac3':
      return 'm4a';
    default:
      return 'flac';
  }
}

export function contentTypeFor(ext: string): string {
  switch (ext) {
    case 'flac':
      return 'audio/flac';
    case 'alac':
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'aiff':
      return 'audio/aiff';
    case 'mp3':
      return 'audio/mpeg';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}
