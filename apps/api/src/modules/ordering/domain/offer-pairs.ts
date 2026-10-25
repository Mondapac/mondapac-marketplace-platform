import { BOUGHT_TOGETHER_MAX_PARTNERS_STORED } from './offer-pairs-limits';

/**
 * The fewest distinct buyer accounts that make a pair (personalization decision 1, amended
 * 2026-10-25): one account placing three orders must not be able to push its Offer onto a rival's
 * page.
 */
export const BOUGHT_TOGETHER_MIN_BUYERS = 3;
/**
 * An order with more distinct Offers than this is not counted: it is a bulk or reseller basket,
 * not a "bought together" signal, and it alone would add n(n-1)/2 pairs (20 Offers: 190).
 */
export const MAX_OFFERS_PER_COUNTED_ORDER = 20;
/**
 * The most entries the counter holds while counting, where an entry is one pair key or one
 * (pair, buyer) membership. A hard ceiling on memory: when it is hit the rebuild is refused and the
 * old table stays (the counter never drops pairs or buyers silently). Buyer ids are interned to
 * small integers, so an entry costs a Map or Set slot, not a string.
 */
export const MAX_COUNTER_ENTRIES = 4_000_000;

/**
 * One pair of Offers and the distinct buyer accounts that bought both in one order each;
 * `offerId` sorts before `pairedOfferId`. `orders` keeps its (stored) name but holds the number of
 * distinct buyers, not of orders.
 */
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
 * Counts Offer pairs over orders (pure). Each order is its buyer account id and the list of its
 * lines' Offer ids; an Offer on several lines (two variants) counts once. A pair counts once per
 * distinct buyer however many orders that buyer placed with it. An order with more than
 * {@link MAX_OFFERS_PER_COUNTED_ORDER} distinct Offers is skipped. Only pairs with at least
 * {@link BOUGHT_TOGETHER_MIN_BUYERS} distinct buyers are kept, each once in ascending id order.
 * The buyer id lives only in this object's memory for the run: it is never returned, stored or
 * logged.
 */
export class OfferPairCounter {
  readonly #buyersByPair = new Map<string, Set<number>>();
  readonly #buyerIndex = new Map<string, number>();
  #entries = 0;

  constructor(private readonly maxEntries: number = MAX_COUNTER_ENTRIES) {}

  /** Adds one order. `ceiling` means the counter is full: stop and refuse the rebuild. */
  add(buyerId: string, offerIds: readonly string[]): AddOutcome {
    const distinct = [...new Set(offerIds)].sort();
    if (distinct.length > MAX_OFFERS_PER_COUNTED_ORDER) return 'skipped-large';
    let buyer = this.#buyerIndex.get(buyerId);
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const key = `${distinct[i]} ${distinct[j]}`;
        let buyers = this.#buyersByPair.get(key);
        if (buyers === undefined) {
          if (this.#entries >= this.maxEntries) return 'ceiling';
          buyers = new Set();
          this.#buyersByPair.set(key, buyers);
          this.#entries += 1;
        }
        if (buyer === undefined) {
          buyer = this.#buyerIndex.size;
          this.#buyerIndex.set(buyerId, buyer);
        }
        if (!buyers.has(buyer)) {
          if (this.#entries >= this.maxEntries) return 'ceiling';
          buyers.add(buyer);
          this.#entries += 1;
        }
      }
    }
    return 'counted';
  }

  /** The pairs that reach the threshold; `orders` is the distinct buyers. */
  pairs(): OfferPairCount[] {
    const kept: OfferPairCount[] = [];
    for (const [key, buyers] of this.#buyersByPair) {
      if (buyers.size < BOUGHT_TOGETHER_MIN_BUYERS) continue;
      const [offerId, pairedOfferId] = key.split(' ') as [string, string];
      kept.push({ offerId, pairedOfferId, orders: buyers.size });
    }
    return kept;
  }
}

/**
 * The rows to store: both directions of each pair, keeping for each Offer only its top
 * {@link BOUGHT_TOGETHER_MAX_PARTNERS_STORED} partners (most buyers, ties by Offer id), because no
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
