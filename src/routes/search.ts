import type { TrackRow } from '../db.js';
import { foldText, tokenize } from '../parse.js';

/**
 * Quality negotiation, in BitChord's vocabulary.
 *
 * Two vocabularies arrive on the same parameter. Our own picker sends
 * `max|atmos|hires|cd`; a client that has no picker (or a download kept at a lower
 * tier) sends the native `LOSSLESS|HIGH|LOW`. Both are mapped here once.
 *
 * `LOW` maps to `none` on purpose. BitChord asks for LOW on a metered connection,
 * and the smallest thing this addon holds is a whole lossless album track — serving
 * a 120 MB FLAC against a 128 kbps intent is worse than letting the track fall
 * through to the next source.
 */
export type Tier = 'max' | 'atmos' | 'hires' | 'cd' | 'none';

export function normalizeTier(raw: string | undefined): Tier {
  const value = (raw ?? '').trim().toLowerCase();
  switch (value) {
    case 'atmos':
      return 'atmos';
    case 'hires':
      return 'hires';
    case 'cd':
      return 'cd';
    case 'max':
    case 'lossless':
      return 'max';
    case 'high':
      return 'cd';
    case 'low':
      return 'none';
    default:
      break;
  }
  if (value.includes('atmos') || value.includes('dolby')) return 'atmos';
  if (value.includes('hi-res') || value.includes('hi_res') || value.includes('24-bit')) return 'hires';
  if (value.includes('lossless')) return 'max';
  if (value.includes('128') || value.includes('96') || value.includes('low')) return 'none';
  return 'max';
}

/** A row's quality, from what was measured — never from what a release name claimed. */
export function rowScore(row: TrackRow, tier: Tier, atmosWanted: boolean): number {
  let score = 0;
  const hiRes = (row.bitDepth ?? 0) >= 24;
  if (row.atmos) score += tier === 'atmos' || atmosWanted ? 70 : 15;
  if (row.lossless) score += 35;
  if (hiRes) score += 20;
  if (tier === 'hires') score += hiRes ? 45 : -25;
  if (tier === 'cd') score += row.lossless && !hiRes ? 30 : row.lossless ? 10 : -20;
  if (!row.lossless && !row.atmos) score -= 45;
  return score;
}

/**
 * How well a row is the recording that was asked for.
 *
 * This matters more than it looks. When BitChord resolves a YouTube-queued track
 * through this addon it keeps YouTube's metadata and takes only our audio, so the
 * row is never shown — it is only *judged*. A library holding the album and the
 * single, or a live version beside the studio one, must hand back the studio cut,
 * and a quality-first ordering would hand back whichever file happened to be
 * hi-res. Title overlap counts double: it is what separates
 * `So What` from `So What (Live at Newport)`.
 */
/** Words that mark a different cut of a recording, not a better copy of it. */
const VERSION_WORDS = new Set([
  'live',
  'remix',
  'instrumental',
  'karaoke',
  'demo',
  'edit',
  'acoustic',
  'remaster',
  'remastered',
  'sped',
  'slowed',
  'reprise',
]);

export function matchScore(row: TrackRow, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const title = foldText(row.title);
  const hay = `${title} ${foldText(row.artist)} ${foldText(row.album)}`;
  const anywhere = tokens.filter((token) => hay.includes(token)).length / tokens.length;
  const inTitle = tokens.filter((token) => title.includes(token)).length / tokens.length;

  // Sharing every word is not the same as being the same recording: `So What
  // (Live at Newport)` matches a query for `So What` exactly as well as `So What`
  // does. The words a title carries *beyond* the query are what tells them apart,
  // and a version marker among them is decisive.
  const extra = tokenize(row.title).filter((token) => !tokens.includes(token));
  const penalty = extra.length * 10 + (extra.some((token) => VERSION_WORDS.has(token)) ? 25 : 0);
  return Math.max(0, anywhere * 55 + inTitle * 45 - penalty);
}

/**
 * Order the candidates for a request.
 *
 * The three rules that come straight from the docs:
 *  - an Atmos request still has to play when there is no immersive mix, so the
 *    stereo lossless rows are the fallback rather than an empty answer;
 *  - `atmos=auto` means "prefer the immersive mix when one exists", never "fail
 *    without it";
 *  - a tier is a preference, not a filter: something playable beats nothing.
 */
export function rankRows(
  rows: TrackRow[],
  tier: Tier,
  atmosWanted: boolean,
  tokens: string[] = [],
): TrackRow[] {
  if (tier === 'none') return [];
  const playable = rows.filter((row) => row.playable);
  if (tier === 'atmos') {
    const immersive = playable.filter((row) => row.atmos);
    if (immersive.length > 0) return byMatch(immersive, tokens);
    return byMatch(
      playable.filter((row) => row.lossless),
      tokens,
    );
  }
  // Match first, quality second: the same recording at CD quality beats a hi-res
  // file that only shares a word with what was asked for.
  return playable
    .map((row) => ({
      row,
      match: Math.round(matchScore(row, tokens)),
      quality: rowScore(row, tier, atmosWanted),
    }))
    .sort((a, b) => b.match - a.match || b.quality - a.quality)
    .map((entry) => entry.row);
}

function byMatch(rows: TrackRow[], tokens: string[]): TrackRow[] {
  return rows
    .map((row) => ({ row, match: Math.round(matchScore(row, tokens)) }))
    .sort((a, b) => b.match - a.match)
    .map((entry) => entry.row);
}

/** One search row, in the shape the addon protocol defines. */
export function toAddonTrack(row: TrackRow, artworkUrl?: string): Record<string, unknown> {
  const track: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
  };
  // Without this the player has no poster for an addon row: a YouTube row brings
  // its own thumbnail, an addon row only shows what the addon sends.
  if (artworkUrl) {
    track.artworkURL = artworkUrl;
    track.albumArtworkURL = artworkUrl;
  }
  if (row.durationSec && row.durationSec > 0) track.duration = Math.round(row.durationSec);

  if (row.atmos) {
    // Immersive rows carry all three spellings the app reads, because a catalogue
    // that publishes Dolby as its own track otherwise loses to a stereo row that
    // happens to have a better quality label.
    track.format = 'eac3-joc';
    track.audioQuality = 'DOLBY_ATMOS';
    track.audioMode = 'DOLBY_ATMOS';
    track.audioModes = ['DOLBY_ATMOS'];
    track.atmos = true;
    return track;
  }
  track.format = row.codec && row.codec !== 'unknown' ? row.codec : row.format;
  if (row.lossless) {
    track.audioQuality = (row.bitDepth ?? 0) >= 24 ? 'HI_RES_LOSSLESS' : 'LOSSLESS';
  }
  return track;
}

/** A hit-rate worry worth surfacing in logs: a query that tokenises to nothing. */
export function hasUsableQuery(query: string | undefined): boolean {
  return tokenize(query ?? '').length > 0;
}
