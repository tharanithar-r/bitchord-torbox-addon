import { describe, expect, it } from 'vitest';
import { downloadCover, findCoverSource, upsizedArtwork } from '../src/artfinder.js';

function fetchStub(searchBody: unknown, imageBytes?: Uint8Array): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('itunes.apple.com')) {
      return new Response(JSON.stringify(searchBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (imageBytes) {
      return new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

const HIT = {
  results: [
    {
      artistName: 'Miles Davis',
      collectionName: 'Kind of Blue',
      artworkUrl100: 'https://is1.mzstatic.com/image/thumb/x/100x100bb.jpg',
    },
  ],
};

describe('catalogue cover lookup', () => {
  it('asks for the largest version of the cover it finds', () => {
    expect(upsizedArtwork('https://is1.mzstatic.com/a/100x100bb.jpg')).toBe(
      'https://is1.mzstatic.com/a/600x600bb.jpg',
    );
  });

  it('returns the cover of the matching album', async () => {
    const source = await findCoverSource('Miles Davis', 'Kind of Blue', { fetchImpl: fetchStub(HIT) });
    expect(source?.url).toContain('600x600bb.jpg');
    expect(source?.mime).toBe('image/jpeg');
  });

  it('refuses a result that is not the same recording', async () => {
    const wrong = {
      results: [
        {
          artistName: 'Somebody Else',
          collectionName: 'Completely Different',
          artworkUrl100: 'https://is1.mzstatic.com/image/thumb/y/100x100bb.jpg',
        },
      ],
    };
    await expect(
      findCoverSource('Miles Davis', 'Kind of Blue', { fetchImpl: fetchStub(wrong) }),
    ).resolves.toBeNull();
  });

  it('returns null when the catalogue errors or times out', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(findCoverSource('A', 'B', { fetchImpl: failing })).resolves.toBeNull();
    const throwing = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    await expect(findCoverSource('A', 'B', { fetchImpl: throwing })).resolves.toBeNull();
  });

  it('downloads the image so it can be served from our own host', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2]);
    const source = { url: 'https://is1.mzstatic.com/a/600x600bb.jpg', mime: 'image/jpeg' };
    const got = await downloadCover(source, { fetchImpl: fetchStub({}, bytes) });
    expect(got?.byteLength).toBe(bytes.byteLength);
  });
});
