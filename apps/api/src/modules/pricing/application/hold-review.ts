import type { PendingHoldCursor } from './ports/price-series.repository';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

// Small pieces the four price-hold review use cases share: the queue cursor, the page size and
// the id of the record a screen names.

/** Rows per page of the queue when the caller names none (pricing-data 6.2: a page of 50). */
export const DEFAULT_HOLD_PAGE = 50;
export const MAX_HOLD_PAGE = 100;

const CURSOR = /^([0-9]{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** An opaque cursor: the last row's `(submittedAt, id)`. */
export function encodeHoldCursor(cursor: PendingHoldCursor): string {
  return `${cursor.submittedAt.epochMilliseconds}.${cursor.id}`;
}

/** Null when the text is not a cursor this module wrote. */
export function decodeHoldCursor(text: string): PendingHoldCursor | null {
  const match = CURSOR.exec(text);
  if (match === null) return null;
  const id = parseId<'RegularPriceRecord'>(match[2] as string);
  if (!id.ok) return null;
  const millis = Number(match[1]);
  if (!Number.isSafeInteger(millis)) return null;
  try {
    return { submittedAt: Temporal.Instant.fromEpochMilliseconds(millis), id: id.value };
  } catch {
    return null;
  }
}

export function parseRecordId(value: unknown): Id<'RegularPriceRecord'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'RegularPriceRecord'>(value);
  return parsed.ok ? parsed.value : null;
}
