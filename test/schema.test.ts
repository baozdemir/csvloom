import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { parseDetailed } from '../src/detailed.ts';
import { parse } from '../src/parse.ts';
import { isStandardSchema, rowResult, validateRow, validateRowSync } from '../src/schema.ts';
import type { SchemaError, SchemaIssue, SchemaResult, StandardSchemaV1 } from '../src/types.ts';
import { records } from './differential.ts';

// Hand-written Standard Schema v1 objects: no validator package is needed.
const schemaOf = <Output>(
  validate: (value: unknown) => SchemaResult<Output> | Promise<SchemaResult<Output>>,
): StandardSchemaV1<unknown, Output> => ({ '~standard': { version: 1, vendor: 'test', validate } });

const AGE = 'age must be a number';
const ageResult = (value: unknown): SchemaResult<{ age: number }> =>
  typeof (value as { age?: unknown }).age === 'number'
    ? { value: value as { age: number } }
    : { issues: [{ message: AGE, path: ['age'] }] };
const age = schemaOf(ageResult);
const asyncAge = schemaOf((value) => Promise.resolve(ageResult(value)));
const returning = (result: unknown) => schemaOf(() => result as SchemaResult<unknown>);
const failing = (issues: readonly SchemaIssue[]) => returning({ issues });

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('nothing was thrown');
};

describe('validateRow', () => {
  it("valid rows become the schema's output", () => {
    expect(validateRow(age, { age: 5 }, 0)).toStrictEqual({ value: { age: 5 } });
  });

  it('one error per issue, with the row', () => {
    const row = { age: 'x' };
    const errors = validateRow(age, row, 3) as SchemaError[];
    expect(errors).toStrictEqual([
      {
        type: 'Schema',
        code: 'InvalidRow',
        message: AGE,
        row: 3,
        path: ['age'],
        value: { age: 'x' },
      },
    ]);
    expect(Object.keys(errors[0] ?? {})).toStrictEqual([
      'type',
      'code',
      'message',
      'row',
      'path',
      'value',
    ]);
    expect(errors[0]?.value).toBe(row);
  });

  it('two issues give two errors with the same row and the same value object', () => {
    const row = ['a', 'b'];
    const errors = validateRow(
      failing([
        { message: 'first', path: [0] },
        { message: 'second', path: [1] },
      ]),
      row,
      4,
    ) as SchemaError[];
    expect(errors).toStrictEqual([
      { type: 'Schema', code: 'InvalidRow', message: 'first', row: 4, path: [0], value: row },
      { type: 'Schema', code: 'InvalidRow', message: 'second', row: 4, path: [1], value: row },
    ]);
    expect(errors[0]?.value).toBe(row);
    expect(errors[1]?.value).toBe(row);
  });

  it('an issue without a path gives an error without a path key', () => {
    const errors = validateRow(failing([{ message: 'bad' }]), {}, 1) as SchemaError[];
    expect(errors).toStrictEqual([
      { type: 'Schema', code: 'InvalidRow', message: 'bad', row: 1, value: {} },
    ]);
    expect(Object.keys(errors[0] ?? {})).toStrictEqual(['type', 'code', 'message', 'row', 'value']);
  });

  it('a { key } path segment becomes its key', () => {
    const errors = validateRow(
      failing([{ message: 'bad', path: [{ key: 'a' }, 0] }]),
      {},
      0,
    ) as SchemaError[];
    expect(errors[0]?.path).toStrictEqual(['a', 0]);
  });

  it('an empty issues list still reports the row', () => {
    const row = { age: 1 };
    const errors = validateRow(failing([]), row, 7) as SchemaError[];
    expect(errors).toStrictEqual([
      {
        type: 'Schema',
        code: 'InvalidRow',
        message: 'Schema validation failed without an issue',
        row: 7,
        value: { age: 1 },
      },
    ]);
    expect(Object.keys(errors[0] ?? {})).toStrictEqual(['type', 'code', 'message', 'row', 'value']);
    expect(errors[0]?.value).toBe(row);
  });

  it('a transforming schema gives the transformed value and leaves the row as it was', () => {
    const toNumber = schemaOf((value) => ({
      value: { age: Number((value as { age: string }).age) },
    }));
    const row = { age: '6' };
    expect(validateRow(toNumber, row, 0)).toStrictEqual({ value: { age: 6 } });
    expect(row).toStrictEqual({ age: '6' });
  });

  it('a valid output of undefined is kept', () => {
    expect(validateRow(returning({ value: undefined }), 'x', 0)).toStrictEqual({
      value: undefined,
    });
  });

  it('an async schema: the same Promise is returned, and rowResult of its result is the sync result', async () => {
    for (const [row, index] of [
      [{ age: 5 }, 0],
      [{ age: 'x' }, 3],
    ] as const) {
      const promise = Promise.resolve(ageResult(row));
      expect(validateRow(returning(promise), row, index)).toBe(promise);
      const awaited = await (validateRow(asyncAge, row, index) as Promise<SchemaResult<unknown>>);
      expect(rowResult(awaited, row, index)).toStrictEqual(validateRow(age, row, index));
    }
  });

  it('a thenable that is not a Promise of this realm is returned as is', () => {
    const thenable = { then: () => undefined };
    expect(validateRow(returning(thenable), {}, 0)).toBe(thenable);
  });

  it('a validate that throws: the throw propagates unchanged', () => {
    const error = new Error('validator');
    const throwing = schemaOf(() => {
      throw error;
    });
    expect(caught(() => validateRow(throwing, {}, 0))).toBe(error);
  });

  it("calls validate as a method of '~standard', with one argument (this)", () => {
    const calls: unknown[][] = [];
    const self: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'self',
        validate(...args: unknown[]) {
          calls.push(args);
          return this.vendor === 'self' ? { value: args[0] } : { issues: [{ message: 'this' }] };
        },
      },
    };
    expect(validateRow(self, 'row', 0)).toStrictEqual({ value: 'row' });
    expect(calls).toStrictEqual([['row']]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'value'],
    ['{} without value', {}],
    ['issues: undefined without value', { issues: undefined }],
    ['issues that are not an array', { issues: 'bad' }],
  ])('a result that is neither shape (%s) throws a TypeError', (_name, result) => {
    const message = 'Parse option "schema" returned a result without "value" or "issues"';
    expect(() => validateRow(returning(result), {}, 0)).toThrow(new TypeError(message));
    expect(() => rowResult(result as SchemaResult<unknown>, {}, 0)).toThrow(new TypeError(message));
  });
});

describe('isStandardSchema', () => {
  it('is true for an object and for a function carrying a version 1 "~standard"', () => {
    expect(isStandardSchema(age)).toBe(true);
    expect(isStandardSchema(Object.assign(() => undefined, age))).toBe(true);
  });

  it.each([
    ['{}', {}],
    ['null', null],
    ['undefined', undefined],
    ['a string', '~standard'],
    ['version 2', { '~standard': { version: 2, vendor: 'v', validate: () => ({ value: 1 }) } }],
    ['no validate', { '~standard': { version: 1, vendor: 'v' } }],
    ['a "~standard" of null', { '~standard': null }],
  ])('is false for %s', (_name, value) => {
    expect(isStandardSchema(value)).toBe(false);
  });
});

describe('a Promise in a synchronous parse (F5-d)', () => {
  const message =
    'Parse option "schema" returned a Promise; use parseStream for an async validator';

  it('validateRowSync gives what validateRow gives for a synchronous result', () => {
    expect(validateRowSync(age, { age: 5 }, 0)).toStrictEqual(validateRow(age, { age: 5 }, 0));
    expect(validateRowSync(age, { age: 'x' }, 2)).toStrictEqual(validateRow(age, { age: 'x' }, 2));
  });

  it('a Promise from the validator throws, after a rejection handler is attached to it', () => {
    const handlers: unknown[][] = [];
    const thenable = {
      then(...args: unknown[]) {
        handlers.push(args.map((handler) => typeof handler));
      },
    };
    expect(caught(() => validateRowSync(returning(thenable), {}, 0))).toStrictEqual(
      new TypeError(message),
    );
    expect(handlers).toStrictEqual([['function', 'function']]);
    expect(() => validateRowSync(asyncAge, { age: 5 }, 0)).toThrow(new TypeError(message));
  });

  it('the refused promise is not an unhandled rejection (fresh node, default flags)', () => {
    const fixture = fileURLToPath(new URL('fixtures/schema-promise-child.mjs', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, [fixture], { encoding: 'utf8', env });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('2 scenarios refused and settled\n');
    expect(child.status).toBe(0);
  });
});

/** What the generated validator decided for one row: the oracle of the property test. */
type Outcome =
  | { valid: true; output: unknown; async: boolean }
  | { valid: false; issues: number; async: boolean };

/**
 * A validator that decides each call at random and logs the decision: valid with the row itself
 * or a new object as output, or invalid with 0 to 3 issues ({ issues: [] } included), each
 * synchronous or, for asyncShare of the calls, as a Promise.
 */
function generatedSchema(random: () => number, log: Outcome[], asyncShare = 0.3): StandardSchemaV1 {
  return schemaOf((row) => {
    const async = random() < asyncShare;
    const draw = random();
    let result: SchemaResult<unknown>;
    if (draw < 0.5) {
      const output = draw < 0.25 ? row : { output: row };
      log.push({ valid: true, output, async });
      result = { value: output };
    } else {
      const issues = Math.floor(random() * 4);
      log.push({ valid: false, issues, async });
      result = {
        issues: Array.from({ length: issues }, (_, k) =>
          k % 2 === 0 ? { message: `m${String(k)}` } : { message: 'p', path: [{ key: 'f' }, k] },
        ),
      };
    }
    return async ? Promise.resolve(result) : result;
  });
}

describe('every input row is in data or in an error value', () => {
  it('holds for parsed rows of 500 seeds, with header and without, the counts adding up', async () => {
    const seen = { rows: 0, valid: 0, emptyIssues: 0, async: 0 };
    for (let seed = 1; seed <= 500; seed++) {
      const random = mulberry32(seed);
      const header = random() < 0.5;
      const rows: unknown[] = parse(records(random, ',', '\n'), {
        delimiter: ',',
        newline: '\n',
        header,
      }).data;
      const log: Outcome[] = [];
      const schema = generatedSchema(random, log);
      const data: unknown[] = [];
      const errors: SchemaError[] = [];
      for (const [index, row] of rows.entries()) {
        let checked = validateRow(schema, row, index);
        if (!Array.isArray(checked) && 'then' in checked) {
          checked = rowResult(await checked, row, index);
        }
        if (Array.isArray(checked)) errors.push(...checked);
        else data.push(checked.value);
      }

      expect(log).toHaveLength(rows.length);
      const expectedData = log.flatMap((outcome) => (outcome.valid ? [outcome.output] : []));
      expect(data).toHaveLength(expectedData.length);
      for (const [k, output] of data.entries()) expect(output).toBe(expectedData[k]);
      let expectedErrors = 0;
      for (const [index, outcome] of log.entries()) {
        const own = errors.filter((error) => error.row === index);
        if (outcome.valid) {
          expect(own).toStrictEqual([]);
          continue;
        }
        expect(own).toHaveLength(Math.max(1, outcome.issues));
        for (const error of own) expect(error.value).toBe(rows[index]);
        expectedErrors += Math.max(1, outcome.issues);
      }
      expect(errors).toHaveLength(expectedErrors);
      const invalidRows = new Set(errors.map((error) => error.row)).size;
      expect(data.length + invalidRows).toBe(rows.length);

      seen.rows += rows.length;
      seen.valid += data.length;
      seen.emptyIssues += log.filter((outcome) => !outcome.valid && outcome.issues === 0).length;
      seen.async += log.filter((outcome) => outcome.async).length;
    }
    expect(seen.rows).toBeGreaterThanOrEqual(1500);
    expect(seen.valid).toBeGreaterThanOrEqual(500);
    expect(seen.emptyIssues).toBeGreaterThanOrEqual(100);
    expect(seen.async).toBeGreaterThanOrEqual(300);
  });
});

describe('schema through parseDetailed', () => {
  const LF = { delimiter: ',', newline: '\n' } as const;
  const ageError = (row: number, value: unknown) => ({
    type: 'Schema',
    code: 'InvalidRow',
    message: AGE,
    row,
    path: ['age'],
    value,
  });

  it('data holds valid rows only, as the schema returned them; the validator sees typed values with dynamicTyping', () => {
    const result = parseDetailed('age\n5\nx', {
      ...LF,
      header: true,
      dynamicTyping: true,
      schema: age,
    });
    expect(Object.keys(result)).toStrictEqual(['data', 'errors', 'meta']);
    expect(result.data).toStrictEqual([{ age: 5 }]);
    expect(result.errors).toStrictEqual([ageError(1, { age: 'x' })]);
    expect(result.meta).toStrictEqual(parse('age\n5\nx', { ...LF, header: true }).meta);
    // Without dynamicTyping the validator receives the strings, and no row is a number.
    const untyped = parseDetailed('age\n5\nx', { ...LF, header: true, schema: age });
    expect(untyped.data).toStrictEqual([]);
    expect(untyped.errors).toStrictEqual([ageError(0, { age: '5' }), ageError(1, { age: 'x' })]);
  });

  it('a transforming schema: data holds its output, and transform and dynamicTyping ran before it', () => {
    const received: unknown[] = [];
    const doubled = schemaOf((value) => {
      received.push(value);
      return { value: { twice: (value as { n: number }).n * 2 } };
    });
    const result = parseDetailed('n\n 2\n3', {
      ...LF,
      header: true,
      transform: (value) => value.trim(),
      dynamicTyping: true,
      schema: doubled,
    });
    expect(received).toStrictEqual([{ n: 2 }, { n: 3 }]);
    expect(result.data).toStrictEqual([{ twice: 4 }, { twice: 6 }]);
    expect(result.errors).toStrictEqual([]);
  });

  it('reports Schema errors after the others: Quotes, Delimiter, FieldMismatch, Schema', () => {
    // No delimiter gives two fields per record on average, so "," is used and reported.
    const result = parseDetailed('age\nx\n2\n3\n4,"5', {
      header: true,
      dynamicTyping: true,
      schema: age,
    });
    expect(result.errors.map(({ type, code }) => `${type}/${code}`)).toStrictEqual([
      'Quotes/MissingQuotes',
      'Delimiter/UndetectableDelimiter',
      'FieldMismatch/TooManyFields',
      'Schema/InvalidRow',
    ]);
    expect(result.errors.at(-1)).toStrictEqual(ageError(0, { age: 'x' }));
    expect(result.data).toStrictEqual([{ age: 2 }, { age: 3 }, { age: 4, __parsed_extra: [5] }]);
  });

  it('row counts rows before validation, in FieldMismatch errors too', () => {
    const result = parseDetailed('age,b\nx,1\n7\n8,2\ny,3', {
      ...LF,
      header: true,
      dynamicTyping: true,
      schema: age,
    });
    expect(result.data).toStrictEqual([{ age: 7 }, { age: 8, b: 2 }]);
    expect(result.errors).toStrictEqual([
      {
        type: 'FieldMismatch',
        code: 'TooFewFields',
        message: 'Too few fields: expected 2 fields but parsed 1',
        row: 1,
      },
      ageError(0, { age: 'x', b: 1 }),
      ageError(3, { age: 'y', b: 3 }),
    ]);
  });

  it('validates the final [""] record like any other row, unless skipEmptyLines or repair removed it', () => {
    const config = { ...LF, header: true, dynamicTyping: true, schema: age } as const;
    // The short final record's object lacks the key "age", and the schema sees that.
    const kept = parseDetailed('a,age\n1,5\n', config);
    expect(kept.data).toStrictEqual([{ a: 1, age: 5 }]);
    expect(kept.errors.at(-1)).toStrictEqual(ageError(1, { a: null }));
    expect(kept.errors.map((error) => error.code)).toStrictEqual(['TooFewFields', 'InvalidRow']);
    expect(parseDetailed('a,age\n1,5\n', { ...config, skipEmptyLines: true })).toMatchObject({
      data: [{ a: 1, age: 5 }],
      errors: [],
    });
    expect(
      parseDetailed('a,age\n1,5\n', { ...config, repair: ['trailing-empty-record'] }),
    ).toMatchObject({ data: [{ a: 1, age: 5 }], errors: [] });
  });

  it('without header the validator receives arrays', () => {
    const received: unknown[] = [];
    const pair = schemaOf((value) => {
      received.push(value);
      return Array.isArray(value) && value.length === 2
        ? { value }
        : { issues: [{ message: 'two fields', path: [{ key: 'length' }] }] };
    });
    const result = parseDetailed('a,b\n1\n2,3', { ...LF, schema: pair });
    expect(received).toStrictEqual([['a', 'b'], ['1'], ['2', '3']]);
    expect(result.data).toStrictEqual([
      ['a', 'b'],
      ['2', '3'],
    ]);
    expect(result.errors).toStrictEqual([
      {
        type: 'Schema',
        code: 'InvalidRow',
        message: 'two fields',
        row: 1,
        path: ['length'],
        value: ['1'],
      },
    ]);
  });

  it('with positions: true a Schema error has the position of its record, after its own keys', () => {
    const { errors } = parseDetailed('\ufeffage\n5\nx', {
      ...LF,
      header: true,
      dynamicTyping: true,
      schema: age,
      positions: true,
    });
    expect(errors).toStrictEqual([
      { ...ageError(1, { age: 'x' }), line: 3, column: 1, offset: 7, snippet: 'x' },
    ]);
    expect(Object.keys(errors[0] ?? {})).toStrictEqual([
      'type',
      'code',
      'message',
      'row',
      'path',
      'value',
      'line',
      'column',
      'offset',
      'snippet',
    ]);
    // Two issues of one row share the record's position.
    const two = parseDetailed('a\n1\n2', {
      ...LF,
      header: true,
      schema: failing([{ message: 'first' }, { message: 'second', path: ['a'] }]),
      positions: true,
    });
    expect(
      two.errors.map((error) => [
        error.message,
        'row' in error ? error.row : -1,
        error.offset,
        error.line,
      ]),
    ).toEqual([
      ['first', 0, 2, 2],
      ['second', 0, 2, 2],
      ['first', 1, 4, 3],
      ['second', 1, 4, 3],
    ]);
  });

  it('a Promise from the validator throws in parseDetailed, and nothing is returned', () => {
    const message =
      'Parse option "schema" returned a Promise; use parseStream for an async validator';
    expect(
      caught(() => parseDetailed('age\n5', { ...LF, header: true, schema: asyncAge })),
    ).toStrictEqual(new TypeError(message));
    // The handler is attached to the promise before the throw.
    const handlers: unknown[][] = [];
    const thenable = {
      then(...args: unknown[]) {
        handlers.push(args.map((handler) => typeof handler));
      },
    };
    expect(
      caught(() => parseDetailed('a\n1\n2', { ...LF, schema: returning(thenable) })),
    ).toStrictEqual(new TypeError(message));
    expect(handlers).toStrictEqual([['function', 'function']]);
  });

  it('the refused promise of a parseDetailed call is not an unhandled rejection (fresh node, default flags)', () => {
    const fixture = fileURLToPath(new URL('fixtures/detailed-promise-child.mjs', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, [fixture], { encoding: 'utf8', env });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('2 parses refused and settled\n');
    expect(child.status).toBe(0);
  });

  it('what the validator throws, or a result of neither shape, propagates out of parseDetailed', () => {
    const error = new RangeError('from the validator');
    const throwing = schemaOf(() => {
      throw error;
    });
    expect(caught(() => parseDetailed('a\n1', { ...LF, schema: throwing }))).toBe(error);
    expect(caught(() => parseDetailed('a\n1', { ...LF, schema: returning({}) }))).toStrictEqual(
      new TypeError('Parse option "schema" returned a result without "value" or "issues"'),
    );
  });

  it('is not called for the header record, a comment line or a record skipEmptyLines removes', () => {
    const received: unknown[] = [];
    const recording = schemaOf((value) => {
      received.push(value);
      return { value };
    });
    parseDetailed('#c\na\n\n1\n', {
      ...LF,
      header: true,
      comments: true,
      skipEmptyLines: true,
      schema: recording,
    });
    expect(received).toStrictEqual([{ a: '1' }]);
  });

  it('every row parsed is in data or is the value of an error, the counts adding up: 500 seeds', () => {
    const seen = { rows: 0, valid: 0, emptyIssues: 0, otherErrors: 0 };
    for (let seed = 1; seed <= 500; seed++) {
      const random = mulberry32(seed);
      const config = {
        ...LF,
        header: random() < 0.5,
        skipEmptyLines: random() < 0.3,
        dynamicTyping: random() < 0.3,
      };
      const input = records(random, ',', '\n');
      const plain = parse(input, config);
      const rows: unknown[] = plain.data;
      const log: Outcome[] = [];
      const result = parseDetailed(input, { ...config, schema: generatedSchema(random, log, 0) });

      expect(log).toHaveLength(rows.length);
      expect(result.meta).toStrictEqual(plain.meta);
      const schemaErrors = result.errors.filter((error) => error.type === 'Schema');
      // The other errors are parse's, before the Schema errors.
      expect(result.errors.slice(0, plain.errors.length)).toStrictEqual(plain.errors);
      expect(result.errors).toHaveLength(plain.errors.length + schemaErrors.length);
      const expectedData = log.flatMap((outcome) => (outcome.valid ? [outcome.output] : []));
      expect(result.data).toHaveLength(expectedData.length);
      for (const [k, output] of result.data.entries()) expect(output).toBe(expectedData[k]);
      let expectedErrors = 0;
      for (const [index, outcome] of log.entries()) {
        const own = schemaErrors.filter((error) => error.row === index);
        if (outcome.valid) {
          expect(own).toStrictEqual([]);
          continue;
        }
        expect(own).toHaveLength(Math.max(1, outcome.issues));
        for (const error of own) expect(error.value).toStrictEqual(rows[index]);
        expectedErrors += Math.max(1, outcome.issues);
      }
      expect(schemaErrors).toHaveLength(expectedErrors);
      const invalidRows = new Set(schemaErrors.map((error) => error.row)).size;
      expect(result.data.length + invalidRows).toBe(rows.length);

      seen.rows += rows.length;
      seen.valid += result.data.length;
      seen.emptyIssues += log.filter((outcome) => !outcome.valid && outcome.issues === 0).length;
      seen.otherErrors += plain.errors.length;
    }
    expect(seen.rows).toBeGreaterThanOrEqual(1500);
    expect(seen.valid).toBeGreaterThanOrEqual(500);
    expect(seen.emptyIssues).toBeGreaterThanOrEqual(100);
    expect(seen.otherErrors).toBeGreaterThanOrEqual(100);
  }, 60_000);
});
