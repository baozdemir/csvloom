// csv-rex 0.7.0 ships no type declarations; this covers only what bench/adapters/csv-rex.ts uses.
declare module 'csv-rex/parse' {
  export interface CsvRexOptions {
    header?: boolean;
    delimiterChar?: string;
    newlineChar?: string;
    quoteChar?: string;
  }
  export interface CsvRexEntry {
    idx: number;
    data?: unknown;
    err?: { code: string; message: string };
  }
  export interface CsvRexParser {
    chunkParse(
      chunk: string,
      controller: { enqueue(entry: CsvRexEntry): void },
      isLast?: boolean,
    ): void;
    previousChunk(): string;
  }
  export default function parseAll(input: string, options?: CsvRexOptions): unknown[];
  export function parse(options?: CsvRexOptions): CsvRexParser;
}

declare module 'csv-rex/format' {
  /** With enableReturn: true the whole CSV text is returned (csv-rex/format.mjs). */
  export function format(
    data: readonly unknown[],
    options: {
      header: readonly string[] | false;
      delimiterChar: string;
      newlineChar: string;
      quoteChar: string;
      enableReturn: true;
    },
  ): string;
}
