// The U1 runner's tables (bench/u1.ts) and the checksum the U1 arms share, on made-up records:
// no browser runs here and none of these numbers is a measurement.
import { describe, expect, it } from 'vitest';
import { AA, ARMS, renderU1 } from '../bench/u1.ts';
import { tally } from './browser/page/u1-tally.ts';

describe('U1 checksum', () => {
  it('counts rows and changes with a field, its length or the order', () => {
    const sum = (rows: object[]) => {
      const state = { rows: 0, sum: 0 };
      tally(state, rows);
      return state;
    };
    const base = sum([
      { a: 'café', b: '1' },
      { a: 'x', b: '' },
    ]);
    expect(base.rows).toBe(2);
    expect(
      sum([
        ['café', '1'],
        ['x', ''],
      ]),
    ).toEqual(base);
    expect(
      sum([
        { a: 'cafe', b: '1' },
        { a: 'x', b: '' },
      ]).sum,
    ).not.toBe(base.sum);
    expect(
      sum([
        { a: 'caf\uFFFDe', b: '1' },
        { a: 'x', b: '' },
      ]).sum,
    ).not.toBe(base.sum);
    expect(
      sum([
        { a: 'x', b: '' },
        { a: 'café', b: '1' },
      ]).sum,
    ).not.toBe(base.sum);
  });
});

describe('renderU1', () => {
  // papa-main takes 0.5x bulk-main's time, so that comparison loses and comes first; round 3 of
  // papa-worker has the wrong checksum and is listed as FAIL, not used.
  const time: Record<string, number> = {
    'stream-worker': 100,
    [AA]: 100,
    'stream-main': 100,
    'bulk-main': 200,
    'papa-worker': 300,
    'papa-main': 100,
  };
  const reference = { rows: 5, sum: 7 };
  const records: Record<string, unknown>[] = [
    {
      type: 'start',
      campaign: 'test',
      seed: 1,
      rounds: 10,
      browserVersion: '0.0',
      files: [{ id: 'simple-32MiB', bytes: 1, sha256: 'x', reference }],
    },
  ];
  for (let round = 1; round <= 10; round++) {
    for (const label of [...ARMS, AA]) {
      const ms = (time[label] ?? 0) * (1 + round / 1000);
      const sum = label === 'papa-worker' && round === 3 ? 8 : 7;
      records.push({
        type: 'run',
        round,
        file: 'simple-32MiB',
        label,
        rows: 5,
        sum,
        totalMs: ms,
        firstBatchMs: ms / 2,
        maxGapMs: 5,
        idleMaxGapMs: 4,
        match: sum === 7,
      });
    }
  }
  records.push({ type: 'end', status: 'complete' });
  const text = renderU1(records);

  it('lists the losing comparison first, the A/A row last, and the failed run', () => {
    const total = text.slice(text.indexOf('### Total time'), text.indexOf('### Time to the first'));
    const rows = total.split('\n').filter((line) => line.includes(' / '));
    expect(rows[0]).toMatch(/^\| papa-main \/ bulk-main \| 0\.500 \|/);
    expect(rows.at(-1)).toMatch(/^\| stream-worker-aa \/ stream-worker \(A\/A\) \| 1\.000 \|/);
    expect(total).toMatch(
      /\| papa-worker \/ stream-worker \| 3\.000 \| [\d.]+-[\d.]+ \| 9 \| csv-engine ahead \|/,
    );
    expect(text).toContain('FAIL round 3 papa-worker: rows 5, sum 8 differ from the generator');
    expect(text).toContain('Chromium 0.0 headless on Linux; not a claim about other browsers');
    expect(text).not.toContain('INCOMPLETE');
  });

  it('marks a campaign that did not end complete', () => {
    expect(renderU1(records.slice(0, -1))).toContain('INCOMPLETE');
    // A --dry-run file ends with its own status: it never reads as a campaign.
    expect(renderU1([...records.slice(0, -1), { type: 'end', status: 'dry-run' }])).toContain(
      'INCOMPLETE',
    );
  });
});
