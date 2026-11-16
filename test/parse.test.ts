import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  formatOfFile,
  ftsQuery,
  ftsQueryLoose,
  isAtmosName,
  isHiResName,
  isIndexableAudio,
  normalizeQuery,
  parseFileName,
  parseReleaseName,
  searchableTitle,
  tokenize,
} from '../src/parse.js';

describe('file names', () => {
  it('reads extension case-insensitively', () => {
    expect(extensionOf('Disc 1/01 Song.FLAC')).toBe('flac');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });

  it('indexes music but not video containers', () => {
    expect(isIndexableAudio('01 - So What.flac')).toBe(true);
    expect(isIndexableAudio('album.m4a')).toBe(true);
    // A film is an MKV with an audio track; indexing it would bury the music.
    expect(isIndexableAudio('Movie.2023.2160p.mkv')).toBe(false);
    expect(isIndexableAudio('cover.jpg')).toBe(false);
  });

  it('keeps m4a ambiguous until it is probed', () => {
    expect(formatOfFile('track.m4a')).toBe('m4a');
    expect(formatOfFile('track.alac')).toBe('alac');
    expect(formatOfFile('track.aif')).toBe('aiff');
  });

  it('strips disc and track prefixes', () => {
    expect(parseFileName('01 - So What.flac')).toMatchObject({ title: 'So What', trackNo: 1 });
    expect(parseFileName('1-02 Blue in Green.flac')).toMatchObject({
      title: 'Blue in Green',
      discNo: 1,
      trackNo: 2,
    });
    expect(parseFileName('CD2/03 Flamenco Sketches.flac')).toMatchObject({
      title: 'Flamenco Sketches',
      discNo: 2,
      trackNo: 3,
    });
    expect(parseFileName('So_What.flac')).toMatchObject({ title: 'So What' });
  });
});

describe('release names', () => {
  it('splits artist, album and year', () => {
    const info = parseReleaseName('Miles Davis - Kind of Blue (1959) [FLAC 24-96]');
    expect(info.artist).toBe('Miles Davis');
    expect(info.album).toBe('Kind of Blue');
    expect(info.year).toBe('1959');
    expect(info.claimsLossless).toBe(true);
    expect(info.claimsHiRes).toBe(true);
  });

  it('detects Dolby claims', () => {
    expect(isAtmosName('Hans Zimmer - Interstellar (2014) [Dolby Atmos]')).toBe(true);
    expect(isAtmosName('Some Album [FLAC]')).toBe(false);
  });

  it('handles a name with no artist separator', () => {
    const info = parseReleaseName('Random Access Memories [FLAC]');
    expect(info.artist).toBe('');
    expect(info.album).toBe('Random Access Memories');
  });
});

describe('search text', () => {
  it('folds accents so cafe matches Café', () => {
    expect(tokenize('Café Del Mar')).toEqual(['cafe', 'del', 'mar']);
  });

  it('drops single characters and duplicates', () => {
    expect(tokenize('a a in in the the')).toEqual(['in', 'the']);
  });

  it('builds an AND query by default, OR as the fallback', () => {
    expect(ftsQuery(['radiohead', 'rainbows'])).toBe('"radiohead"* AND "rainbows"*');
    expect(ftsQueryLoose(['radiohead', 'rainbows'])).toBe('"radiohead"* OR "rainbows"*');
    expect(ftsQuery([])).toBeNull();
  });

  it('normalises a YouTube-shaped query to the words an index stores', () => {
    expect(normalizeQuery('Paniyon Sa (From "Satyamev Jayate")')).toBe('Paniyon Sa');
    expect(normalizeQuery('Song [Official Video]')).toBe('Song');
    expect(normalizeQuery('Track (Lyric Video)')).toBe('Track');
    expect(normalizeQuery('So What')).toBe('So What');
  });

  it('removes the packaging BitChord is given by YouTube titles', () => {
    expect(searchableTitle('Paniyon Sa (From "Satyamev Jayate")')).toBe('Paniyon Sa');
    expect(searchableTitle('Song [feat. Someone]')).toBe('Song');
  });
});
