/** The fewest distinct paid orders that make a pair (personalization decision 1). */
export const BOUGHT_TOGETHER_MIN_ORDERS = 3;

/** One pair of Offers and the distinct orders that hold both; `offerId` sorts before `pairedOfferId`. */
export interface OfferPairCount {
  readonly offerId: string;
  readonly pairedOfferId: string;
  readonly orders: number;
}

/**
 * Counts Offer pairs over orders (pure). Each order is the list of its lines' Offer ids; an Offer
 * on several lines (two variants) counts once, so a pair counts once per order. Only pairs with at
 * least {@link BOUGHT_TOGETHER_MIN_ORDERS} distinct orders are kept, each once in ascending id
 * order; the store writes both directions.
 */
export class OfferPairCounter {
  readonly #counts = new Map<string, number>();

  /** Adds one order. */
  add(offerIds: readonly string[]): void {
    const distinct = [...new Set(offerIds)].sort();
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const key = `${distinct[i]} ${distinct[j]}`;
        this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
      }
    }
  }

  /** The pairs that reach the threshold. */
  pairs(): OfferPairCount[] {
    const kept: OfferPairCount[] = [];
    for (const [key, orders] of this.#counts) {
      if (orders < BOUGHT_TOGETHER_MIN_ORDERS) continue;
      const [offerId, pairedOfferId] = key.split(' ') as [string, string];
      kept.push({ offerId, pairedOfferId, orders });
    }
    return kept;
  }
}
