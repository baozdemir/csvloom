// The row count and field checksum of the U1 arms, shared by the page, its
// worker, test/browser/u1.pw.ts and bench/u1.ts. The checksum folds, in order, each field's length
// and its first and last code units, so it costs one step per field, not per character.
export interface Tally {
  rows: number;
  sum: number;
}

export function tally(state: Tally, rows: readonly object[]): void {
  let sum = state.sum;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      const text = String(value);
      sum = Math.imul(sum ^ text.length, 16777619);
      if (text.length > 0)
        sum = Math.imul(
          sum ^ text.charCodeAt(0) ^ (text.charCodeAt(text.length - 1) << 16),
          16777619,
        );
    }
  }
  state.rows += rows.length;
  state.sum = sum;
}
