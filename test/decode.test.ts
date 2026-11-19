import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { ByteDecoder, DECODE_WINDOW } from '../src/decode.ts';

const BOM = String.fromCharCode(0xfeff);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const reference = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/** ASCII; Turkish letters with U+FEFF first; U+FEFF inside, 4-byte emoji and CJK; two U+FEFF. */
const TEXTS = [
  'id,name\n1,plain ascii\n',
  `${BOM}ad,şehir\nAyşe,İzmir\nÇağrı,Muğla\né,ğ\n`,
  `x${BOM}y,😀\n😀😀,${BOM}\n中文,日本語,한국어\n`,
  `${BOM}${BOM}😀`,
];
const WINDOWS = [1, 2, 3, 4, 64, DECODE_WINDOW];

/** Decodes the chunks in order through one ByteDecoder: every window of each, then the end. */
function decodeChunks(chunks: readonly Uint8Array[], window: number): string {
  const decoder = new ByteDecoder(window);
  let text = '';
  for (const chunk of chunks) {
    decoder.load(chunk);
    for (let part = decoder.next(); part !== undefined; part = decoder.next()) text += part;
  }
  return text + decoder.finish();
}

/** The bytes cut once at every position, plus uncut. */
function cuts(bytes: Uint8Array): Uint8Array[][] {
  const result = [[bytes]];
  for (let k = 0; k <= bytes.length; k++) result.push([bytes.subarray(0, k), bytes.subarray(k)]);
  return result;
}

/**
 * Runs `run` with spies on Uint8Array subarray and slice and on TextDecoder decode, and returns
 * what they recorded, copied before the spies are restored (mockRestore clears them).
 */
function record<T>(run: () => T): {
  result: T;
  subarray: { view: Uint8Array; args: unknown[] }[];
  slice: Uint8Array[];
  decode: unknown[][];
} {
  const subarray = vi.spyOn(Uint8Array.prototype, 'subarray');
  const slice = vi.spyOn(Uint8Array.prototype, 'slice');
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    const result = run();
    return {
      result,
      subarray: subarray.mock.calls.map((args, i) => ({
        view: subarray.mock.contexts[i] as Uint8Array,
        args,
      })),
      slice: slice.mock.contexts.map((view) => view as Uint8Array),
      decode: decode.mock.calls.map((args) => [...args]),
    };
  } finally {
    subarray.mockRestore();
    slice.mockRestore();
    decode.mockRestore();
  }
}

describe('ByteDecoder', () => {
  it('equals one TextDecoder over the whole input at every byte cut and every window', () => {
    for (const text of TEXTS) {
      const bytes = encode(text);
      expect(reference(bytes)).toBe(text);
      for (const chunks of cuts(bytes)) {
        for (const window of WINDOWS) expect(decodeChunks(chunks, window)).toBe(text);
      }
    }
  });

  it('keeps a BOM that a chunk cut splits', () => {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
    for (const k of [1, 2]) {
      const text = decodeChunks([bytes.subarray(0, k), bytes.subarray(k)], DECODE_WINDOW);
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text).toBe(`${BOM}a`);
    }
  });

  it('returns undefined at once, without decoding, for an empty chunk', () => {
    const decoder = new ByteDecoder(DECODE_WINDOW);
    decoder.load(new Uint8Array(0));
    const seen = record(() => decoder.next());
    expect(seen.result).toBeUndefined();
    expect(seen.decode).toStrictEqual([]);
  });

  it('gives a window that ends inside a sequence as an empty text', () => {
    const decoder = new ByteDecoder(1);
    decoder.load(encode('😀'));
    expect([decoder.next(), decoder.next(), decoder.next(), decoder.next()]).toStrictEqual([
      '',
      '',
      '',
      '😀',
    ]);
    expect(decoder.next()).toBeUndefined();
    expect(decoder.finish()).toBe('');
  });

  describe('invalid UTF-8 throws a TypeError', () => {
    /** Where the first throw comes from: a next() call, or finish() after every next() passed. */
    function failure(chunks: readonly number[][], window: number): { at: string; error: unknown } {
      const decoder = new ByteDecoder(window);
      try {
        for (const chunk of chunks) {
          decoder.load(Uint8Array.from(chunk));
          while (decoder.next() !== undefined);
        }
      } catch (error) {
        return { at: 'next', error };
      }
      try {
        decoder.finish();
      } catch (error) {
        return { at: 'finish', error };
      }
      return { at: 'none', error: undefined };
    }

    const CASES: [string, number[][], 'next' | 'finish'][] = [
      ['an invalid byte (61 FF)', [[0x61, 0xff]], 'next'],
      ['a sequence the end cuts (61 C3)', [[0x61, 0xc3]], 'finish'],
      ['a 4-byte sequence the end cuts (F0 9F 98)', [[0xf0, 0x9f, 0x98]], 'finish'],
      ['an overlong encoding (C0 80)', [[0xc0, 0x80]], 'next'],
      ['an encoded lone surrogate (ED A0 80)', [[0xed, 0xa0, 0x80]], 'next'],
      ['a cut sequence the next chunk breaks (E2 82 | 41)', [[0xe2, 0x82], [0x41]], 'next'],
    ];
    it.each(CASES)('%s, from %s', (_name, chunks, at) => {
      for (const window of WINDOWS) {
        const result = failure(chunks, window);
        expect(result.at).toBe(at);
        expect(result.error).toBeInstanceOf(TypeError);
      }
    });
  });

  it('decodes a 32 MiB chunk as 32 views of DECODE_WINDOW bytes, then flushes once', () => {
    const text = 'a,b\n'.repeat(8 * 2 ** 20);
    const chunk = encode(text);
    expect(chunk.length).toBe(32 * DECODE_WINDOW);
    const decoder = new ByteDecoder(DECODE_WINDOW);
    const control = Uint8Array.of(0);
    const seen = record(() => {
      const parts: string[] = [];
      decoder.load(chunk);
      for (let part = decoder.next(); part !== undefined; part = decoder.next()) parts.push(part);
      control.slice();
      return { parts, rest: decoder.finish() };
    });
    const { parts, rest } = seen.result;
    expect(parts).toHaveLength(32);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(DECODE_WINDOW);
    expect(parts.join('') + rest).toBe(text);

    // Identity and buffer checks only: a deep comparison of 32 MiB arrays would take minutes.
    const windows = seen.subarray.filter(({ view }) => view === chunk).map(({ args }) => args);
    expect(windows).toStrictEqual(
      parts.map((_, k) => [k * DECODE_WINDOW, (k + 1) * DECODE_WINDOW]),
    );
    expect(seen.slice).toContain(control);
    const copies = seen.slice.filter((view) => view.buffer === chunk.buffer);
    expect(copies.length).toBe(0);

    expect(seen.decode).toHaveLength(33);
    for (const [input, options] of seen.decode.slice(0, 32)) {
      expect(input).toBeInstanceOf(Uint8Array);
      expect((input as Uint8Array).buffer).toBe(chunk.buffer);
      expect((input as Uint8Array).byteLength).toBeLessThanOrEqual(DECODE_WINDOW);
      expect(options).toStrictEqual({ stream: true });
    }
    expect(seen.decode[32]).toStrictEqual([]);
  });

  it('decodes a Buffer, a Uint8Array of another realm and a Uint8Array subclass the same', () => {
    class Bytes extends Uint8Array {}
    const kinds: Record<string, (bytes: Uint8Array) => Uint8Array> = {
      Buffer: (bytes) => Buffer.from(bytes),
      'another realm': (bytes) =>
        runInNewContext('Uint8Array.from(values)', { values: Array.from(bytes) }) as Uint8Array,
      subclass: (bytes) => new Bytes(bytes),
    };
    const text = TEXTS[2] ?? '';
    const bytes = encode(text);
    for (const [kind, make] of Object.entries(kinds)) {
      for (const chunks of cuts(bytes)) {
        const made = chunks.map(make);
        if (kind === 'another realm') expect(made[0]).not.toBeInstanceOf(Uint8Array);
        else expect(made[0]).toBeInstanceOf(Uint8Array);
        for (const window of [1, 3, 64]) expect(decodeChunks(made, window), kind).toBe(text);
      }
    }
  });
});
