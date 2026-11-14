import { Temporal } from '@mondapac/shared-kernel';

/**
 * How long after a seller order is delivered its seller may still read the customer's delivery
 * address and phone (and the note the customer wrote to it, which travels with the address).
 * Owner decision of 14 Nov 2026: 30 days, the same in every Market. A per-Market setting is a
 * later option; until then this is the one place the period lives. Expressed in hours because a
 * Temporal.Instant only adds exact units.
 */
export const SELLER_SHIP_TO_RETENTION = Temporal.Duration.from({ hours: 30 * 24 });

/**
 * Whether the seller may still see where its order went: always before delivery (to-ship, or
 * shipped and not delivered yet), and until `deliveredAt + 30 days` after it; from that instant
 * on, never. For a pickup order `deliveredAt` is the moment the buyer collected it.
 */
export function sellerMaySeeShipTo(
  deliveredAt: Temporal.Instant | null,
  now: Temporal.Instant,
): boolean {
  if (deliveredAt === null) return true;
  return Temporal.Instant.compare(now, deliveredAt.add(SELLER_SHIP_TO_RETENTION)) < 0;
}
