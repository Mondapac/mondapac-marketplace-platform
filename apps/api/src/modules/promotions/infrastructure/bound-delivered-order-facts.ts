import type { Known } from '../application/ports/customer-facts';
import type {
  DeliveredOrderFacts,
  DeliveredSellerOrderFacts,
} from '../application/ports/order-facts';

/**
 * The {@link DeliveredOrderFacts} promotions holds: `ordering` imports `promotions` (checkout,
 * package T2), so promotions cannot import ordering's facade. `PromotionsOrderEventsModule`
 * binds the facade reader at start-up; until then, and for any failure, the answer is "unknown",
 * so the handlers retry and no credit is issued on a guess.
 */
export class BoundDeliveredOrderFacts implements DeliveredOrderFacts {
  #reader: DeliveredOrderFacts | null = null;

  bind(reader: DeliveredOrderFacts): void {
    this.#reader = reader;
  }

  async read(
    ...[context, request]: Parameters<DeliveredOrderFacts['read']>
  ): Promise<Known<DeliveredSellerOrderFacts>> {
    if (this.#reader === null) return { known: false };
    return this.#reader.read(context, request).catch(() => ({ known: false }) as const);
  }
}
