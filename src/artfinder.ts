/**
 * Artwork for rips that carry none of their own.
 *
 * The Tidal and Qobuz addons always have a picture, because their catalogue has
 * one. A debrid library does not: a rip with no FLAC `PICTURE` block has nothing
 * to serve, and the player then shows a blank tile for a row that is otherwise
 * perfect. The gap is ours to close, and it is closable for free — iTunes'
 * public search API answers artist+album with cover art and needs no key.
 *
 * Deliberately narrow: one lookup per album, at probe time, stored in the same
 * `art` table as embedded covers so the media route serves both identically. A
 * miss costs one request and is not retried for that album.
 */
export type CoverSource = { url: string; mime: string };

export const ITUNES_SEARCH = 'https://itunes.apple.com/search';

type ItunesResult = {
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
};

/** `600x600` is the largest size iTunes serves from the same pattern. */
export function upsizedArtwork(url: string): string {
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/600x600bb.$1');
}

function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The album's cover, or null when iTunes has nothing convincing.
 *
 * "Convincing" is the point: a wrong poster is worse than none, so the artist
 * must appear in the result and the album name must share a word with it.
 */
export async function findCoverSource(
  artist: string,
  album: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CoverSource | null> {
  const wantedAlbum = normalise(album);
  const wantedArtist = normalise(artist);
  if (wantedAlbum === '' || wantedAlbum.length < 2) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(ITUNES_SEARCH);
  url.searchParams.set('term', `${artist} ${album}`.trim());
  url.searchParams.set('entity', 'album');
  url.searchParams.set('limit', '8');

  try {
    const response = await fetchImpl(url.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { results?: ItunesResult[] };
    const results = body.results ?? [];

    const albumWords = wantedAlbum.split(' ').filter((word) => word.length >= 3);
    const scored = results
      .map((result) => {
        const artwork = result.artworkUrl100;
        if (!artwork) return null;
        const resultAlbum = normalise(String(result.collectionName ?? ''));
        const resultArtist = normalise(String(result.artistName ?? ''));
        let score = 0;
        if (wantedArtist !== '' && resultArtist.includes(wantedArtist)) score += 40;
        if (resultAlbum === wantedAlbum) score += 40;
        else if (albumWords.some((word) => resultAlbum.includes(word))) score += 15;
        return { score, artwork };
      })
      .filter((entry): entry is { score: number; artwork: string } => entry !== null)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 40) return null;
    const url600 = upsizedArtwork(best.artwork);
    return { url: url600, mime: url600.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' };
  } catch {
    return null;
  }
}

/** Fetch the image itself, bounded, so the addon can serve it from its own host. */
export async function downloadCover(
  source: CoverSource,
  options: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<Uint8Array | null> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > maxBytes) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}
