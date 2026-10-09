import { Temporal, type Id } from '@mondapac/shared-kernel';
import { sellableOf, sellableOfSellUnit } from './stock';

// The sellable quantity of a stock item and of a sell unit (inventory design 4.1, Q10), the one
// place reads, caps and allocation share. Pure: the instant comes from the caller's Clock.

/** A reservation line as the held sum reads it (data design 4.3). */
export interface HeldLine {
  readonly stockItemId: Id<'StockItem'>;
  readonly status: 'active' | 'released' | 'expired' | 'committed' | 'fulfilled' | 'cancelled';
  readonly expiresAt: Temporal.Instant;
  readonly quantity: number;
}

/**
 * A line is held while ACTIVE and `expiresAt > now`, or COMMITTED (pending until shipped): expiry
 * is derived here, so the cleanup job is never needed for correctness (design 4.1, AC 4).
 */
export function isHeld(line: HeldLine, now: Temporal.Instant): boolean {
  if (line.status === 'committed') return true;
  return line.status === 'active' && Temporal.Instant.compare(line.expiresAt, now) > 0;
}

/** Units held on each stock item at `now`. */
export function heldByItem(
  lines: readonly HeldLine[],
  now: Temporal.Instant,
): ReadonlyMap<Id<'StockItem'>, number> {
  const held = new Map<Id<'StockItem'>, number>();
  for (const line of lines) {
    if (isHeld(line, now))
      held.set(line.stockItemId, (held.get(line.stockItemId) ?? 0) + line.quantity);
  }
  return held;
}

export const SellableCalculator = {
  held: heldByItem,
  ofItem: sellableOf,
  ofSellUnit: sellableOfSellUnit,
} as const;
