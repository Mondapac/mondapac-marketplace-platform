import { BOUGHT_TOGETHER_MAX_PARTNERS_STORED } from './offer-pairs-limits';

/** The fewest distinct paid orders that make a pair (personalization decision 1). */
export const BOUGHT_TOGETHER_MIN_ORDERS = 3;
/**
 * An order with more distinct Offers than this is not counted: it is a bulk or reseller basket,
 * not a "bought together" signal, and it alone would add n(n-1)/2 pairs (20 Offers: 190).
 */
export const MAX_OFFERS_PER_COUNTED_ORDER = 20;
/**
 * The most distinct pairs the counter holds while counting. A hard ceiling on memory: when it is
 * hit the rebuild is refused and the old table stays (the counter never drops pairs silently).
 */
export const MAX_PAIR_KEYS = 2_000_000;

/** One pair of Offers and the distinct orders that hold both; `offerId` sorts before `pairedOfferId`. */
export interface OfferPairCount {
  readonly offerId: string;
  readonly pairedOfferId: string;
  readonly orders: number;
}

/** One stored row: `pairedOfferId` is a partner of `offerId`. */
export type DirectedOfferPair = OfferPairCount;

/** What {@link OfferPairCounter.add} did with an order. */
export type AddOutcome = 'counted' | 'skipped-large' | 'ceiling';

/**
 * Counts Offer pairs over orders (pure). Each order is the list of its lines' Offer ids; an Offer
 * on several lines (two variants) counts once, so a pair counts once per order. An order with more
 * than {@link MAX_OFFERS_PER_COUNTED_ORDER} distinct Offers is skipped. Only pairs with at least
 * {@link BOUGHT_TOGETHER_MIN_ORDERS} distinct orders are kept, each once in ascending id order.
 */
export class OfferPairCounter {
  readonly #counts = new Map<string, number>();

  constructor(private readonly maxKeys: number = MAX_PAIR_KEYS) {}

  /** Adds one order. `ceiling` means the pair map is full: stop and refuse the rebuild. */
  add(offerIds: readonly string[]): AddOutcome {
    const distinct = [...new Set(offerIds)].sort();
    if (distinct.length > MAX_OFFERS_PER_COUNTED_ORDER) return 'skipped-large';
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const key = `${distinct[i]} ${distinct[j]}`;
        const seen = this.#counts.get(key);
        if (seen === undefined && this.#counts.size >= this.maxKeys) return 'ceiling';
        this.#counts.set(key, (seen ?? 0) + 1);
      }
    }
    return 'counted';
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

/**
 * The rows to store: both directions of each pair, keeping for each Offer only its top
 * {@link BOUGHT_TOGETHER_MAX_PARTNERS_STORED} partners (most orders, ties by Offer id), because no
 * read asks for more. A pair may therefore be stored for one Offer and not for the other.
 */
export function storedRows(pairs: readonly OfferPairCount[]): DirectedOfferPair[] {
  const byOffer = new Map<string, DirectedOfferPair[]>();
  const push = (offerId: string, pairedOfferId: string, orders: number) => {
    const list = byOffer.get(offerId);
    const row = { offerId, pairedOfferId, orders };
    if (list === undefined) byOffer.set(offerId, [row]);
    else list.push(row);
  };
  for (const pair of pairs) {
    push(pair.offerId, pair.pairedOfferId, pair.orders);
    push(pair.pairedOfferId, pair.offerId, pair.orders);
  }
  const rows: DirectedOfferPair[] = [];
  for (const list of byOffer.values()) {
    list.sort(
      (a, b) =>
        b.orders - a.orders ||
        (a.pairedOfferId < b.pairedOfferId ? -1 : a.pairedOfferId > b.pairedOfferId ? 1 : 0),
    );
    rows.push(...list.slice(0, BOUGHT_TOGETHER_MAX_PARTNERS_STORED));
  }
  return rows;
}
