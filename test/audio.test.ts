import { describe, expect, it } from 'vitest';
import {
  detectContainer,
  parseAiff,
  parseAudioHead,
  parseFlac,
  parseMp4,
  parseWav,
  readExtendedFloat,
} from '../src/probe/audio.js';

/** A FLAC head with STREAMINFO (96 kHz / 24-bit / stereo) and a Vorbis comment. */
function flacFile(): Buffer {
  const streamInfo = Buffer.alloc(34);
  const rate = 96_000;
  const channels = 2;
  const bits = 24;
  const totalSamples = 96_000 * 242;
  let packed =
    (BigInt(rate) << 44n) |
    BigInt(channels - 1) << 41n |
    BigInt(bits - 1) << 36n |
    BigInt(totalSamples);
  for (let i = 17; i >= 10; i--) {
    streamInfo[i] = Number(packed & 0xffn);
    packed >>= 8n;
  }

  const vendor = Buffer.from('bitchord-torbox-addon');
  const entries = [
    'TITLE=Midnight Signal',
    'ARTIST=Example Artist',
    'ALBUM=Night Drive',
    'TRACKNUMBER=1',
    'ISRC=USRC12345678',
  ].map((entry) => {
    const bytes = Buffer.from(entry);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendor.length);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length);
  const comment = Buffer.concat([vendorLength, vendor, count, ...entries]);

  const streamInfoHeader = Buffer.from([0x00, 0, 0, 34]);
  const commentHeader = Buffer.from([
    0x84,
    (comment.length >> 16) & 0xff,
    (comment.length >> 8) & 0xff,
    comment.length & 0xff,
  ]);
  return Buffer.concat([Buffer.from('fLaC'), streamInfoHeader, streamInfo, commentHeader, comment]);
}

function wavFile(): Buffer {
  const sampleRate = 44_100;
  const channels = 2;
  const bits = 16;
  const dataSize = sampleRate * channels * (bits / 8) * 3; // three seconds
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);
  const data = Buffer.alloc(8);
  data.write('data', 0);
  data.writeUInt32LE(dataSize, 4);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(4 + fmt.length + data.length + dataSize, 4);
  header.write('WAVE', 8);
  return Buffer.concat([header, fmt, data, Buffer.alloc(1024)]);
}

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function m4aFile(): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(242_000, 16); // duration in timescale units
  const sampleEntry = Buffer.alloc(28);
  sampleEntry.writeUInt16BE(2, 16); // channels
  sampleEntry.writeUInt16BE(24, 18); // sample size
  sampleEntry.writeUInt32BE(44_100 * 65_536, 24); // 16.16 sample rate
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(8), box('alac', sampleEntry)]));
  const moov = box('moov', box('mvhd', mvhd), box('trak', box('mdia', box('minf', box('stbl', stsd)))));
  return Buffer.concat([box('ftyp', Buffer.from('M4A ')), moov]);
}

function aiffFile(): Buffer {
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(2, 0); // channels
  comm.writeUInt32BE(44_100 * 2, 2); // sample frames
  comm.writeUInt16BE(16, 6); // sample size
  // 80-bit extended float for 44100
  comm.writeUInt16BE(0x400e, 8);
  comm.writeUInt32BE(0xac440000, 10);
  comm.writeUInt32BE(0, 14);
  const form = Buffer.alloc(12);
  form.write('FORM', 0);
  form.writeUInt32BE(4 + 8 + comm.length, 4);
  form.write('AIFF', 8);
  return Buffer.concat([form, box8('COMM', comm)]);
}

function box8(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

describe('container sniffing', () => {
  it('identifies formats by magic bytes, not by extension', () => {
    expect(detectContainer(flacFile())).toBe('flac');
    expect(detectContainer(m4aFile())).toBe('mp4');
    expect(detectContainer(wavFile())).toBe('wav');
    expect(detectContainer(aiffFile())).toBe('aiff');
    expect(detectContainer(Buffer.from('not audio at all'))).toBe('unknown');
  });
});

describe('FLAC', () => {
  const probe = parseFlac(flacFile());

  it('reads the real stream parameters', () => {
    expect(probe).not.toBeNull();
    expect(probe?.codec).toBe('flac');
    expect(probe?.sampleRate).toBe(96_000);
    expect(probe?.bitDepth).toBe(24);
    expect(probe?.channels).toBe(2);
  });

  it('computes duration from the sample count, with no decoding', () => {
    expect(Math.round(probe?.durationSec ?? 0)).toBe(242);
  });

  it('reads tags and validates the ISRC', () => {
    expect(probe?.tags.TITLE).toBe('Midnight Signal');
    expect(probe?.tags.ARTIST).toBe('Example Artist');
    expect(probe?.isrc).toBe('USRC12345678');
  });

  it('refuses a file that is not FLAC', () => {
    expect(parseFlac(wavFile())).toBeNull();
  });
});

describe('other containers', () => {
  it('reads WAV header fields and derives duration from the data chunk', () => {
    const probe = parseWav(wavFile());
    expect(probe?.sampleRate).toBe(44_100);
    expect(probe?.bitDepth).toBe(16);
    expect(probe?.channels).toBe(2);
    expect(Math.round(probe?.durationSec ?? 0)).toBe(3);
  });

  it('reads an ALAC sample entry from M4A', () => {
    const probe = parseMp4(m4aFile());
    expect(probe?.codec).toBe('alac');
    expect(probe?.channels).toBe(2);
    expect(probe?.sampleRate).toBe(44_100);
    expect(Math.round(probe?.durationSec ?? 0)).toBe(242);
  });

  it('reads AIFF COMM and its 80-bit float sample rate', () => {
    const probe = parseAiff(aiffFile());
    expect(probe?.sampleRate).toBe(44_100);
    expect(Math.round(probe?.durationSec ?? 0)).toBe(2);
  });

  it('decodes the 80-bit extended float', () => {
    expect(readExtendedFloat(Buffer.from([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]))).toBe(44_100);
  });

  it('routes by content for the entry point', () => {
    expect(parseAudioHead(flacFile())?.container).toBe('flac');
    expect(parseAudioHead(Buffer.from('x'))).toBeNull();
  });
});
