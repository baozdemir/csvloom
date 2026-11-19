// The build's lib (es2022) has no TextDecoder; this is the part used here.
declare const TextDecoder: new (
  label: 'utf-8',
  options: { fatal: boolean; ignoreBOM: boolean },
) => { decode(input?: Uint8Array, options?: { stream?: boolean }): string };

/** Bytes decoded per call. */
export const DECODE_WINDOW = 1_048_576;

const EMPTY = new Uint8Array(0);

/** One stream's UTF-8 decoder: fatal, BOM kept, at most `window` bytes per call. */
export class ByteDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  readonly #window: number;
  #chunk: Uint8Array = EMPTY;
  #offset = 0;

  /** `window`: the most bytes decoded per next() call. */
  constructor(window: number) {
    this.#window = window;
  }

  /** The chunk to decode next. The previous chunk must be used up (next() returned undefined). */
  load(chunk: Uint8Array): void {
    this.#chunk = chunk;
    this.#offset = 0;
  }

  /**
   * The next window's text ('' is possible), or undefined when the chunk is used up. Throws the
   * engine's TypeError on invalid UTF-8.
   */
  next(): string | undefined {
    const chunk = this.#chunk;
    const start = this.#offset;
    if (start >= chunk.length) return undefined;
    const end = start + this.#window;
    this.#offset = end;
    // Release the chunk once its last window is taken.
    if (end >= chunk.length) this.#chunk = EMPTY;
    return this.#decoder.decode(chunk.subarray(start, end), { stream: true });
  }

  /** The end of the input: '' or the engine's TypeError for a sequence the input cut. */
  finish(): string {
    return this.#decoder.decode();
  }
}
