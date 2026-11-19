import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';

// CSV Spectrum 2.0.0 (npm devDependency, BSD-2-Clause per its package.json; the
// package ships no license text or copyright notice, so its files are used from
// node_modules and never copied into this repository). Expected JSON is
// "standards behavior"; differences from Papa Parse 5.7.1 are listed explicitly.

const dir = createRequire(import.meta.url)
  .resolve('csv-spectrum/package.json')
  .replace(/package\.json$/, '');
const cases = readdirSync(`${dir}csvs`)
  .filter((f) => f.endsWith('.csv'))
  .map((f) => f.slice(0, -4))
  .sort();

const load = (name: string) => {
  const csv = new TextDecoder().decode(readFileSync(`${dir}csvs/${name}.csv`));
  const json = JSON.parse(readFileSync(`${dir}json/${name}.json`, 'utf8')) as unknown;
  return { csv, expected: (Array.isArray(json) ? json : [json]) as Array<Record<string, string>> };
};

// Papa adds one record for the final line break (docs/compatibility.md, D2-e).
const LINE_END_RECORD = new Set([
  'escaped_quotes',
  'json',
  'newlines',
  'newlines_crlf',
  'quotes_and_newlines',
  'simple',
  'simple_crlf',
]);

describe('CSV Spectrum 2.0.0 against Papa Parse 5.7.1 (header: true, delimiter: ",")', () => {
  it('has the twelve cases this table lists', () => {
    expect(cases).toHaveLength(12);
  });

  it.each(cases)('%s', (name) => {
    const { csv, expected } = load(name);
    const result = Papa.parse<Record<string, string>>(csv, { header: true, delimiter: ',' });
    if (LINE_END_RECORD.has(name)) {
      const [first = ''] = result.meta.fields ?? [];
      expect(result.data).toStrictEqual([...expected, { [first]: '' }]);
      expect(result.errors.map((e) => e.code)).toStrictEqual(['TooFewFields']);
    } else if (name === 'location_coordinates') {
      // The Spectrum JSON disagrees with its own CSV on the phone number; every
      // other field (including U+FFFD from non-UTF-8 bytes) matches.
      const [row] = result.data;
      const [want] = expected;
      expect(row?.['Contact Phone Number']).toBe('2095257564');
      expect(want?.['Contact Phone Number']).toBe('1234567890');
      expect({ ...row, 'Contact Phone Number': '' }).toStrictEqual({
        ...want,
        'Contact Phone Number': '',
      });
    } else {
      expect(result.data).toStrictEqual(expected);
      expect(result.errors).toStrictEqual([]);
    }
  });
});
