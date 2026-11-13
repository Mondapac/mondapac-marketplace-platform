import { parseId } from '@mondapac/shared-kernel';
import type { Id, Money, Temporal } from '@mondapac/shared-kernel';

// The caps on refunds a seller starts by marking units unavailable (order detail decision 6;
// Hassan F2; owner decision 2026-11-11): at most a number of refunds and an amount in any 24
// hours. An admin sets the Market's default and, apart, any seller's own caps; the seller's own
// win. With neither, the seller path is refused (fail closed). A refusal alerts the admins at
// most once a day per seller. The window is a rolling 24 hours of instants, so no zone is needed.

/** The most refunds a cap may allow in 24 hours (and the database CHECK). */
export const MAX_REFUND_LIMIT_COUNT = 1000;
/** The largest amount cap, in minor units (16 digits, as every refund amount). */
export const MAX_REFUND_LIMIT_AMOUNT = 9_999_999_999_999_999n;
/** The window the caps count over. */
export const REFUND_LIMIT_WINDOW = { hours: 24 } as const;

/** Which cap a refused seller refund would have passed. */
export const REFUND_LIMIT_KINDS = ['count', 'amount'] as const;
export type RefundLimitKind = (typeof REFUND_LIMIT_KINDS)[number];

/** Why the admins are alerted: a cap was reached, or no cap is in force (`unset`; Hassan). */
export const REFUND_LIMIT_ALERTS = [...REFUND_LIMIT_KINDS, 'unset'] as const;
export type RefundLimitAlert = (typeof REFUND_LIMIT_ALERTS)[number];

/** One stored cap: the Market's default (`sellerId` null) or one seller's own. */
export interface RefundLimit {
  readonly id: Id<'SellerRefundLimit'>;
  readonly sellerId: Id<'Seller'> | null;
  readonly maxCount: number;
  readonly maxAmount: Money;
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
}

/** What a seller's own refunds (not failed) came to in the window, before the new one. */
export interface RefundUsage {
  readonly count: number;
  readonly amount: bigint;
}

/** The seller's own cap when an admin set one, else the Market's default, else none. */
export function limitInForce(
  own: RefundLimit | null,
  marketDefault: RefundLimit | null,
): RefundLimit | null {
  return own ?? marketDefault;
}

/**
 * Whether one more refund of `gross` fits the cap in force. `unset` (no cap, or a cap in another
 * currency than the refund's) refuses: an unconfigured Market moves no seller money.
 */
export function checkRefundLimit(
  limit: RefundLimit | null,
  usage: RefundUsage,
  refund: { readonly gross: bigint; readonly currency: string },
): 'within' | 'unset' | RefundLimitKind {
  if (limit === null || limit.maxAmount.currency !== refund.currency) return 'unset';
  if (usage.count + 1 > limit.maxCount) return 'count';
  if (usage.amount + refund.gross > limit.maxAmount.amount) return 'amount';
  return 'within';
}

/** An admin's caps as asked: the count, the amount in minor units, and the version they read. */
export interface RefundLimitInput {
  readonly maxCount: number;
  readonly maxAmount: bigint;
  /** 0 when no row exists yet (a first set); otherwise the version read. */
  readonly expectedVersion: number;
}

type Fields = readonly { readonly path: string; readonly code: string }[];

/**
 * Reads `{ maxCount, maxAmount, expectedVersion }`: a count of 1 to 1000, an amount of minor units
 * as a string of digits above zero, and the version read (0 for none). The currency is the
 * Market's, filled in by the use case.
 */
export function parseRefundLimitInput(input: {
  readonly maxCount: unknown;
  readonly maxAmount: unknown;
  readonly expectedVersion: unknown;
}):
  | { readonly ok: true; readonly value: RefundLimitInput }
  | { readonly ok: false; readonly fields: Fields } {
  const fields: { path: string; code: string }[] = [];
  const count = input?.maxCount;
  const countOk =
    typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= MAX_REFUND_LIMIT_COUNT;
  if (!countOk) fields.push({ path: 'maxCount', code: 'range' });
  const amount = input?.maxAmount;
  let maxAmount = 0n;
  if (typeof amount === 'string' && /^[0-9]{1,16}$/.test(amount)) {
    maxAmount = BigInt(amount);
    if (maxAmount < 1n || maxAmount > MAX_REFUND_LIMIT_AMOUNT) {
      fields.push({ path: 'maxAmount', code: 'range' });
    }
  } else fields.push({ path: 'maxAmount', code: 'format' });
  const version = parseVersion(input?.expectedVersion);
  if (version === null) fields.push({ path: 'expectedVersion', code: 'range' });
  if (fields.length > 0 || version === null) return { ok: false, fields };
  return { ok: true, value: { maxCount: count as number, maxAmount, expectedVersion: version } };
}

/** A version a client read back: a whole number, 0 to 1,000,000; `null` when it is not one. */
export function parseVersion(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
    ? value
    : null;
}

/** A seller id from a path; `null` when it is not an id. */
export function parseSellerId(value: unknown): Id<'Seller'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'Seller'>(value);
  return parsed.ok ? parsed.value : null;
}
