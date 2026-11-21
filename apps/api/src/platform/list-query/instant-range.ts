import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { listQueryInvalid, type ListQueryFailure } from './paging';

// The date filter of a list as ISO 8601 instants, as the admin Orders list takes it: the panel
// turns the days the admin picked into instants in the admin's own zone, or the Market's, before it
// asks (ADR-0005), so the server never guesses a zone. `from` is inclusive, `to` exclusive.

export interface InstantRange {
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

/** An instant with an explicit offset or `Z`; anything else (a bare day, junk) is null. */
function instantOf(value: unknown): Temporal.Instant | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
}

/**
 * Reads `from` and `to` of a closed filters record (`path` prefixes the field in a failure, for
 * example `filters.`). A range that ends at or before it starts is refused.
 */
export function parseInstantRange(
  record: Readonly<Record<string, unknown>>,
  path = 'filters.',
): Result<InstantRange, ListQueryFailure> {
  let from: Temporal.Instant | null = null;
  let to: Temporal.Instant | null = null;
  if (!absent(record['from'])) {
    from = instantOf(record['from']);
    if (from === null) return listQueryInvalid(`${path}from`, 'format');
  }
  if (!absent(record['to'])) {
    to = instantOf(record['to']);
    if (to === null) return listQueryInvalid(`${path}to`, 'format');
  }
  if (from !== null && to !== null && Temporal.Instant.compare(to, from) <= 0) {
    return listQueryInvalid(`${path}to`, 'range');
  }
  return ok({ from, to });
}

/**
 * Reads a filter that picks values from a closed list: absent is null (no filter), else a
 * non-empty array of known values, each counted once.
 */
export function parseClosedValues<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): Result<readonly T[] | null, ListQueryFailure> {
  if (absent(value)) return ok(null);
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) {
    return listQueryInvalid(path, 'type');
  }
  const picked = new Set<T>();
  for (const item of value as unknown[]) {
    const known = allowed.find((candidate) => candidate === item);
    if (known === undefined) return listQueryInvalid(path, 'value');
    picked.add(known);
  }
  return ok([...picked]);
}

/**
 * Reads a date range filter that lives under two named keys of a closed record, for example
 * `createdFrom` and `createdTo`: the same rules as {@link parseInstantRange}, with a failure
 * naming those keys instead of `from` and `to`.
 */
export function parseNamedInstantRange(
  record: Readonly<Record<string, unknown>>,
  fromKey: string,
  toKey: string,
): Result<InstantRange, ListQueryFailure> {
  const range = parseInstantRange({ from: record[fromKey], to: record[toKey] }, '');
  if (range.ok) return range;
  return {
    ok: false,
    error: {
      code: 'validation.failed',
      fields: range.error.fields.map((field) => ({
        path: field.path === 'from' ? fromKey : toKey,
        code: field.code,
      })),
    },
  };
}

/**
 * The instant as a `Date`, rounded up to the millisecond: rows written by the application have
 * millisecond precision, so `>= ceil(from)` and `< ceil(to)` keep a sub-millisecond bound exact.
 */
export function instantBoundDate(instant: Temporal.Instant): Date {
  const ms = instant.epochMilliseconds;
  return new Date(instant.epochNanoseconds % 1_000_000n === 0n ? ms : ms + 1);
}

/**
 * The Prisma comparison of a timestamp column for a range (`from` inclusive, `to` exclusive), or
 * undefined when the range filters nothing.
 */
export function instantRangeWhere(range: InstantRange): { gte?: Date; lt?: Date } | undefined {
  if (range.from === null && range.to === null) return undefined;
  const where: { gte?: Date; lt?: Date } = {};
  if (range.from !== null) where.gte = instantBoundDate(range.from);
  if (range.to !== null) where.lt = instantBoundDate(range.to);
  return where;
}
