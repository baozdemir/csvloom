import type { SchemaError, SchemaIssue, SchemaResult, StandardSchemaV1 } from './types.ts';

const NO_SHAPE = 'Parse option "schema" returned a result without "value" or "issues"';
const NO_ISSUE = 'Schema validation failed without an issue';
const ASYNC = 'Parse option "schema" returned a Promise; use parseStream for an async validator';

const noop = () => undefined;

// Not instanceof Promise: a Promise from another realm is a thenable too.
const isThenable = (value: unknown): value is Promise<SchemaResult<unknown>> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function';

/** The parse option's check: an object whose '~standard' has version 1 and a validate function. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  const props = (
    value as { '~standard'?: { version?: unknown; validate?: unknown } | null } | null | undefined
  )?.['~standard'];
  return props?.version === 1 && typeof props.validate === 'function';
}

/**
 * Validates one row. Returns the output (valid), the row's errors (invalid; row and value set), or
 * the validator's Promise of a result, untouched, for the caller to await or to refuse. Calls
 * schema['~standard'].validate(value) as a method.
 */
export function validateRow(
  schema: StandardSchemaV1,
  value: unknown,
  row: number,
): { value: unknown } | SchemaError[] | Promise<SchemaResult<unknown>> {
  const result = schema['~standard'].validate(value);
  return isThenable(result) ? result : rowResult(result, value, row);
}

/**
 * validateRow for a synchronous parse: a Promise first gets a no-op rejection handler, so that it
 * cannot become an unhandled rejection, and is then refused with a TypeError.
 */
export function validateRowSync(
  schema: StandardSchemaV1,
  value: unknown,
  row: number,
): { value: unknown } | SchemaError[] {
  const result = validateRow(schema, value, row);
  if (!isThenable(result)) return result;
  void result.then(noop, noop);
  throw new TypeError(ASYNC);
}

/** The same decision for an awaited result. */
export function rowResult(
  result: SchemaResult<unknown>,
  value: unknown,
  row: number,
): { value: unknown } | SchemaError[] {
  // A validator written in JavaScript can return anything.
  const shape: unknown = result;
  if (typeof shape === 'object' && shape !== null) {
    const { issues } = shape as { issues?: unknown };
    if (Array.isArray(issues)) {
      return issues.length === 0
        ? [{ type: 'Schema', code: 'InvalidRow', message: NO_ISSUE, row, value }]
        : (issues as SchemaIssue[]).map((issue) => schemaError(issue, value, row));
    }
    if (!issues && 'value' in shape) return { value: shape.value };
  }
  throw new TypeError(NO_SHAPE);
}

function schemaError({ message, path }: SchemaIssue, value: unknown, row: number): SchemaError {
  if (!path) return { type: 'Schema', code: 'InvalidRow', message, row, value };
  const keys = path.map((segment) => (typeof segment === 'object' ? segment.key : segment));
  return { type: 'Schema', code: 'InvalidRow', message, row, path: keys, value };
}
