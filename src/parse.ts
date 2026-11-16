/**
 * Turning TorBox's file names into music metadata.
 *
 * A debrid account has no artist column and no track table: what it has is
 * `short_name` strings inside a torrent named like a scene release. Everything a
 * listener sees in BitChord's search results is derived here — which is why this
 * file is pure and covered by tests rather than being inlined into the indexer.
 *
 * Two rules learned from the existing TorBox addon:
 *
 *  - The extension is the only trustworthy signal (TorBox reports
 *    `application/octet-stream` for plenty of FLACs), and
 *  - video containers are *not* indexed. A movie is an MKV with an audio track;
 *    indexing those would bury the music in a search result set.
 */

/** Formats BitChord will actually play, as codec names it recognises. */
export const LOSSLESS_FORMATS = new Set(['flac', 'alac', 'wav', 'aiff', 'ape', 'wv', 'dsf', 'dff']);

export const LOSSY_FORMATS = new Set(['mp3', 'aac', 'ogg', 'opus', 'm4a']);

/** Extensions indexed as music. Deliberately excludes mkv/mp4/mov/avi. */
const AUDIO_EXTENSIONS = new Set([
  'flac',
  'alac',
  'wav',
  'aiff',
  'aif',
  'ape',
  'wv',
  'dsf',
  'dff',
  'mp3',
  'aac',
  'm4a',
  'ogg',
  'oga',
  'opus',
]);

export function extensionOf(name: string): string {
  const clean = name.split('/').pop() ?? name;
  const dot = clean.lastIndexOf('.');
  return dot <= 0 ? '' : clean.slice(dot + 1).toLowerCase();
}

/** Whether a file belongs in the music index at all. */
export function isIndexableAudio(shortName: string, mimetype?: string | null): boolean {
  const ext = extensionOf(shortName);
  if (AUDIO_EXTENSIONS.has(ext)) return true;
  // A `.m4a` reported only by mime type still counts; an `.mp4` reporting
  // audio/mp4 does not, because that is how most album-length videos look.
  const mime = (mimetype ?? '').toLowerCase();
  return ext === '' && (mime === 'audio/flac' || mime === 'audio/mpeg' || mime === 'audio/x-flac');
}

/**
 * The format label BitChord is told about, before any probing.
 *
 * `m4a`/`mp4` stay ambiguous: the same extension is AAC or ALAC, and only the
 * file's own `stsd` box settles which. The prober corrects this on first play.
 */
export function formatOfFile(shortName: string): string {
  const ext = extensionOf(shortName);
  switch (ext) {
    case 'flac':
    case 'alac':
    case 'wav':
    case 'aiff':
    case 'aif':
    case 'ape':
    case 'wv':
    case 'dsf':
    case 'dff':
    case 'mp3':
    case 'aac':
    case 'ogg':
    case 'oga':
    case 'opus':
      return ext === 'aif' ? 'aiff' : ext === 'oga' ? 'ogg' : ext;
    case 'm4a':
    case 'mp4':
      return 'm4a';
    default:
      return 'unknown';
  }
}

/** Lowercased, accent-free text: `Café` and `Cafe` are the same query. */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Search tokens, in the shape the FTS index can use.
 *
 * BitChord sends a whole `title artist` string (and then a bare title as a second
 * query), so a single-token-only parser would drop half of every query. One
 * character tokens are dropped because `A` matches everything.
 */
export function tokenize(query: string): string[] {
  const tokens = foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  return [...new Set(tokens)];
}

/**
 * An FTS5 MATCH expression: every token required, each as a prefix.
 *
 * AND rather than OR deliberately. `Radiohead In Rainbows` should not answer
 * with every Radiohead album plus every Rainbows album; when AND returns nothing
 * the caller retries with {@link ftsQueryLoose}.
 */
export function ftsQuery(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

export function ftsQueryLoose(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

/** `[FLAC] [24-96] [WEB] [Deluxe Edition]` — the bracket groups of a release name. */
function bracketGroups(name: string): string[] {
  return [...name.matchAll(/[[(]([^\])]{1,60})[\])]/g)]
    .map((m) => foldText(m[1] ?? ''))
    .filter((s) => s.length > 0);
}

export function isAtmosName(name: string): boolean {
  return /\b(atmos|dolby[\s-]?atmos|eac3[\s-]?joc|dd\+?\s?atmos)\b/i.test(name);
}

/** `24-96`, `24bit`, `hi-res`, `192kHz` — a name that claims high resolution. */
export function isHiResName(name: string): boolean {
  return /\b(hi[\s-]?res|24[\s-]?(bit|96|192)|\b96k|\b192k)\b/i.test(name);
}

export function claimsLossless(name: string): boolean {
  const folded = foldText(name);
  return /\b(flac|alac|wav|aiff|ape|dsd|dsf|dff|lossless)\b/.test(folded);
}

export type ReleaseInfo = {
  artist: string;
  album: string;
  year?: string;
  tags: string[];
  claimsLossless: boolean;
  claimsHiRes: boolean;
  claimsAtmos: boolean;
};

/**
 * `Artist - Album (2016) [FLAC 24-96]` → artist, album, year and the claims.
 *
 * The artist/album split is the first ` - `, which is how essentially every
 * music release on a tracker is named; a name with no separator is treated as
 * the album and left without an artist rather than being guessed at.
 */
export function parseReleaseName(name: string): ReleaseInfo {
  const clean = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const sep = clean.indexOf(' - ');
  const artist = sep > 0 ? clean.slice(0, sep).trim() : '';
  const rest = sep > 0 ? clean.slice(sep + 3).trim() : clean;
  const year = /(?:^|[\s.([-])((?:19|20)\d{2})(?:[\s.)\]]|$)/.exec(rest)?.[1];
  const album = rest
    .replace(/[[(](?:19|20)\d{2}[\])]/g, ' ')
    .replace(/[[(][^\])]{1,60}[\])]/g, ' ')
    .replace(/\b(flac|alac|wav|aiff|ape|dsd|mp3|320|v0|web|cd|vinyl|lp|remaster(?:ed)?)\b/gi, ' ')
    .replace(/\b\d{2,3}[\s-](\d{2,3}|bit)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s._-]+$/g, '')
    .trim();
  return {
    artist,
    album: album.length > 0 ? album : rest.trim(),
    year,
    tags: bracketGroups(clean),
    claimsLossless: claimsLossless(clean),
    claimsHiRes: isHiResName(clean),
    claimsAtmos: isAtmosName(clean),
  };
}

export type FileInfo = { title: string; trackNo?: number; discNo?: number };

/**
 * `1-02 Song_Name.flac` → title `Song Name`, disc 1, track 2.
 *
 * Two prefix passes, because album rips routinely carry both a disc and a track
 * number (`1-02`) and some carry the disc as a word (`CD1 03`).
 */
export function parseFileName(shortName: string): FileInfo {
  const bare = (shortName.split('/').pop() ?? shortName).replace(/\.[^.]+$/, '');
  let working = bare.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  let discNo: number | undefined;
  let trackNo: number | undefined;

  // The disc is often a folder rather than part of the file name: `CD2/03 Song.flac`.
  const folderDisc = /(?:^|\/)(?:cd|disc|disk)\s*(\d{1,2})(?:\/|$)/i.exec(shortName);
  if (folderDisc) discNo = Number(folderDisc[1]);

  const discFirst = /^(?:cd|disc|disk)\s*(\d{1,2})[\s._-]+(.+)$/i.exec(working);
  if (discFirst) {
    discNo = Number(discFirst[1]);
    working = discFirst[2] ?? working;
  }
  const pair = /^(\d{1,2})[\s._-](\d{1,3})(?:[\s._-]+)(.+)$/.exec(working);
  if (pair) {
    discNo ??= Number(pair[1]);
    trackNo = Number(pair[2]);
    working = pair[3] ?? working;
  } else {
    const single = /^(\d{1,3})[\s._-]+(.+)$/.exec(working);
    if (single) {
      trackNo = Number(single[1]);
      working = single[2] ?? working;
    }
  }
  const title = working.replace(/\s{2,}/g, ' ').trim();
  return { title: title.length > 0 ? title : bare.trim(), trackNo, discNo };
}

/**
 * The title BitChord should match on: packaging removed, version markers kept.
 *
 * `Song (From "Film") [feat. X]` is filed as `Song` in every catalogue; handing
 * the bracket groups over verbatim makes the row unmatchable.
 */
export function searchableTitle(title: string): string {
  return title
    .replace(/\((?:from|feat\.?|ft\.?|with|prod\.?)[^)]*\)/gi, ' ')
    .replace(/\[(?:feat\.?|ft\.?|with|prod\.?)[^\]]*\]/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A duration in seconds rendered the way BitChord formats it, for the admin page. */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
