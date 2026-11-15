import { Temporal } from '@mondapac/shared-kernel';
import type { Fulfilment } from './order';

/**
 * How long after a seller order is delivered its seller may still read the customer's delivery
 * address and phone (and the note the customer wrote to it, which travels with the address).
 * Owner decision of 14 Nov 2026: 30 days, the same in every Market. A per-Market setting is a
 * later option; until then this is the one place the period lives. Expressed in hours because a
 * Temporal.Instant only adds exact units.
 */
export const SELLER_SHIP_TO_RETENTION = Temporal.Duration.from({ hours: 30 * 24 });

/**
 * How long after a seller order was shipped, when it was never recorded delivered, its seller may
 * still read the address, phone and note. Owner decision of 15 Nov 2026: 60 days, the same in
 * every Market. A per-Market setting is a later option, as for {@link SELLER_SHIP_TO_RETENTION}.
 */
export const SELLER_SHIP_TO_RETENTION_UNDELIVERED = Temporal.Duration.from({ hours: 60 * 24 });

/** What the retention rule reads of one seller order. */
export interface ShipToRetentionFacts {
  readonly fulfilment: Fulfilment;
  readonly shippedAt: Temporal.Instant | null;
  readonly deliveredAt: Temporal.Instant | null;
  /**
   * The order was cancelled, or every unit of the seller order is refunded by refunds that have
   * not failed: nothing is left to send.
   */
  readonly cancelledOrRefundedInFull: boolean;
}

/**
 * Whether the seller may still see where its order goes (owner decisions of 14 and 15 Nov 2026):
 * - cancelled or refunded in full: never, from that moment on;
 * - delivered: until `deliveredAt + 30 days` (for a pickup order, the moment it was collected);
 * - shipped, not delivered: until `shippedAt + 60 days`;
 * - not shipped yet: always.
 * At the limit itself the address is withheld.
 */
export function sellerMaySeeShipTo(facts: ShipToRetentionFacts, now: Temporal.Instant): boolean {
  if (facts.cancelledOrRefundedInFull) return false;
  const before = (limit: Temporal.Instant) => Temporal.Instant.compare(now, limit) < 0;
  if (facts.deliveredAt !== null) return before(facts.deliveredAt.add(SELLER_SHIP_TO_RETENTION));
  if (facts.shippedAt !== null) {
    return before(facts.shippedAt.add(SELLER_SHIP_TO_RETENTION_UNDELIVERED));
  }
  return true;
}
