import type { TrackRow } from '../db.js';
import { tokenize } from '../parse.js';

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
 * Order the candidates for a request.
 *
 * The three rules that come straight from the docs:
 *  - an Atmos request still has to play when there is no immersive mix, so the
 *    stereo lossless rows are the fallback rather than an empty answer;
 *  - `atmos=auto` means "prefer the immersive mix when one exists", never "fail
 *    without it";
 *  - a tier is a preference, not a filter: something playable beats nothing.
 */
export function rankRows(rows: TrackRow[], tier: Tier, atmosWanted: boolean): TrackRow[] {
  if (tier === 'none') return [];
  const playable = rows.filter((row) => row.playable);
  if (tier === 'atmos') {
    const immersive = playable.filter((row) => row.atmos);
    if (immersive.length > 0) return immersive;
    return playable.filter((row) => row.lossless);
  }
  return playable
    .map((row) => ({ row, score: rowScore(row, tier, atmosWanted) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.row);
}

/** One search row, in the shape the addon protocol defines. */
export function toAddonTrack(row: TrackRow): Record<string, unknown> {
  const track: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
  };
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
