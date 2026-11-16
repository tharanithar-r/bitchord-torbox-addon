import { describe, expect, it } from 'vitest';
import { artKeyFor, extractCover, extractFlacPicture, extractMp4Cover } from '../src/art.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** A FLAC head carrying STREAMINFO and a PICTURE block, as a real rip does. */
function flacWithPicture(): Buffer {
  const streamInfo = Buffer.alloc(34);
  const picture = Buffer.concat([
    Buffer.from([0, 0, 0, 3]), // picture type: front cover
    Buffer.from([0, 0, 0, 10]), // mime length
    Buffer.from('image/jpeg'),
    Buffer.from([0, 0, 0, 0]), // description length
    Buffer.from([0, 0, 0, 0]), // width
    Buffer.from([0, 0, 0, 0]), // height
    Buffer.from([0, 0, 0, 0]), // depth
    Buffer.from([0, 0, 0, 0]), // colours
    Buffer.from([0, 0, 0, JPEG.length]),
    JPEG,
  ]);
  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x00, 0, 0, 34]),
    streamInfo,
    Buffer.from([0x86, (picture.length >> 16) & 0xff, (picture.length >> 8) & 0xff, picture.length & 0xff]),
    picture,
  ]);
}

function m4aWithCover(): Buffer {
  const box = (type: string, ...children: Buffer[]): Buffer => {
    const body = Buffer.concat(children);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const data = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from([0, 0, 0, 0]), JPEG]);
  return Buffer.concat([
    box('ftyp', Buffer.from('M4A ')),
    box('moov', box('udta', box('meta', box('ilst', box('covr', box('data', data)))))),
  ]);
}

describe('cover extraction', () => {
  it('reads the PICTURE block of a FLAC', () => {
    const cover = extractFlacPicture(flacWithPicture());
    expect(cover?.mime).toBe('image/jpeg');
    expect(cover?.bytes.byteLength).toBe(JPEG.length);
    expect(cover?.bytes[0]).toBe(0xff);
  });

  it('reads the covr atom of an M4A', () => {
    const cover = extractMp4Cover(m4aWithCover());
    expect(cover?.mime).toBe('image/jpeg');
    expect(cover?.bytes.byteLength).toBe(JPEG.length);
  });

  it('returns nothing rather than throwing for files without art', () => {
    expect(extractCover(Buffer.from('not audio at all'))).toBeNull();
    expect(extractCover(Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), Buffer.alloc(34)]))).toBeNull();
  });

  it('skips a cover that did not fit in the read', () => {
    const buf = flacWithPicture();
    // Truncate mid-picture: a partial cover must not be served as a real one.
    expect(extractFlacPicture(buf.subarray(0, buf.length - 5))).toBeNull();
  });

  it('gives every track of an album the same key', () => {
    expect(artKeyFor('Example Artist', 'Night Drive')).toBe(artKeyFor(' example artist ', 'NIGHT DRIVE'));
    expect(artKeyFor('Example Artist', 'Night Drive')).not.toBe(artKeyFor('Example Artist', 'Other'));
  });
});
