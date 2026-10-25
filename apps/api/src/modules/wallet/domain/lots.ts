import type { Id, Temporal } from '@mondapac/shared-kernel';

// Credit lots (customer wallet package 1): one lot per grant. Spending takes the soonest-expiring
// lot first, promo before refund at an equal expiry; a lot past its expiry is never spent.
// Integers (bigint minor units) only.

export type LotSource = 'promo' | 'refund';

export interface Lot {
  readonly id: Id<'WalletLot'>;
  readonly source: LotSource;
  readonly remaining: bigint;
  /** Null for refund credit, which never expires. */
  readonly expiresAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

export interface Take {
  readonly lotId: Id<'WalletLot'>;
  readonly amount: bigint;
}

const expiryKey = (lot: Lot): number =>
  lot.expiresAt === null ? Number.POSITIVE_INFINITY : lot.expiresAt.epochMilliseconds;

/** The order lots are spent in. */
export function spendOrder(a: Lot, b: Lot): number {
  const byExpiry = expiryKey(a) - expiryKey(b);
  if (byExpiry !== 0 && !Number.isNaN(byExpiry)) return byExpiry < 0 ? -1 : 1;
  if (a.source !== b.source) return a.source === 'promo' ? -1 : 1;
  const byCreation = a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds;
  if (byCreation !== 0) return byCreation < 0 ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const isExpired = (lot: Lot, now: Temporal.Instant): boolean =>
  lot.expiresAt !== null && lot.expiresAt.epochMilliseconds <= now.epochMilliseconds;

/** The lots that may be spent now, in spend order. */
export const spendable = (lots: readonly Lot[], now: Temporal.Instant): Lot[] =>
  lots.filter((lot) => lot.remaining > 0n && !isExpired(lot, now)).sort(spendOrder);

/**
 * Splits `amount` over the spendable lots in spend order. Null when the spendable lots hold less
 * than `amount` (or `amount` is not positive).
 */
export function allocate(
  lots: readonly Lot[],
  amount: bigint,
  now: Temporal.Instant,
): readonly Take[] | null {
  if (amount <= 0n) return null;
  const takes: Take[] = [];
  let left = amount;
  for (const lot of spendable(lots, now)) {
    if (left === 0n) break;
    const take = lot.remaining < left ? lot.remaining : left;
    takes.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return left === 0n ? takes : null;
}
