import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

// The seller's Earnings › Payouts super list (super list phase 4, list 33): its sorts, row
// actions and optional export columns. The one date of the list is the payout day (`slotAt`,
// shown in the store's zone): the default sort, the Previous/Next cursor, the `from`/`to` filter
// and the export's base date column all use it (list33-earnings-date-decision).

export const OWN_PAYOUT_SORT_KEYS = ['slot', 'created', 'amount'] as const;
export type OwnPayoutSortKey = (typeof OWN_PAYOUT_SORT_KEYS)[number];
/** "Payout on: Newest first"; ties by payout id. */
export const OWN_PAYOUT_DEFAULT_SORT: OwnPayoutSortKey = 'slot';
/** The sorts Previous/Next can walk (newest first); amount has page numbers only. */
export const OWN_PAYOUT_CURSOR_KEYS = ['slot', 'created'] as const;
export type OwnPayoutCursorKey = (typeof OWN_PAYOUT_CURSOR_KEYS)[number];

export const OWN_PAYOUT_ROW_ACTIONS = ['open'] as const;
export type OwnPayoutRowAction = (typeof OWN_PAYOUT_ROW_ACTIONS)[number];
export const OWN_PAYOUT_EXPORT_COLUMNS = ['gross', 'netted', 'created', 'updated'] as const;
export type OwnPayoutExportColumn = (typeof OWN_PAYOUT_EXPORT_COLUMNS)[number];

/** Where a Previous/Next page starts: after this payout, in the order of the cursor's sort. */
export interface OwnPayoutCursor {
  readonly key: OwnPayoutCursorKey;
  /** The payout's `slotAt` (slot) or `createdAt` (created). */
  readonly at: Temporal.Instant;
  readonly payoutId: Id<'Payout'>;
}

/**
 * A cursor is `<sort>.<epoch ms>.<payout id>`: opaque to callers and naming its sort, so a cursor
 * made for one sort is refused under another instead of being read as the wrong date.
 */
export const encodeOwnPayoutCursor = (cursor: OwnPayoutCursor): string =>
  `${cursor.key}.${cursor.at.epochMilliseconds}.${cursor.payoutId}`;

/** The cursor, or null when the value is not one this list made. */
export function decodeOwnPayoutCursor(value: unknown): OwnPayoutCursor | null {
  const match =
    typeof value === 'string'
      ? /^(slot|created)\.([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value)
      : null;
  if (match === null) return null;
  const payoutId = parseId<'Payout'>(match[3]!);
  if (!payoutId.ok) return null;
  return {
    key: match[1] as OwnPayoutCursorKey,
    at: Temporal.Instant.fromEpochMilliseconds(Number(match[2])),
    payoutId: payoutId.value,
  };
}
