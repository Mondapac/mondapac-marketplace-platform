import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The cultures of Offers as the index needs them (multi-culture package 3a; ADR-0047 decisions 5
 * and 8), over catalog's culture facade: the shared visibility rule is catalog's, never search's.
 * `null` means the answer could not be read; the caller throws, so the delivery or job is retried
 * rather than indexing an Offer as visible nowhere (or everywhere).
 */
export interface OfferCultureSource {
  /** Per Offer, the codes of the cultures it is visible in (an Offer absent: none). */
  visibleCodes(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, readonly string[]> | null>;

  /** The code of a culture of the context's Market; `undefined` when there is none. */
  codeOf(context: CallContext, cultureId: Id<'Culture'>): Promise<string | undefined | null>;
}

export const OFFER_CULTURE_SOURCE = Symbol('SEARCH_OFFER_CULTURE_SOURCE');
