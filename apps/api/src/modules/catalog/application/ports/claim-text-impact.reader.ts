import type { MarketContext } from '@mondapac/shared-kernel';

/** The kinds of published content the impact count reads (catalog design 6.5). */
export type ImpactTextKind = 'product' | 'offer';

/** One published product or Offer with the texts a customer reads, per locale. */
export interface ImpactTextRow {
  readonly id: string;
  readonly texts: readonly { readonly locale: string; readonly text: string }[];
}

export interface ImpactTextPage {
  readonly rows: readonly ImpactTextRow[];
  /** Pass as `afterId` to continue; null when the scan reached the end. */
  readonly nextAfterId: string | null;
}

/**
 * The read behind `claim-terms.impact-count` (catalog design 6.5): the PUBLISHED texts of the
 * Market, a page at a time in id order. Products: name, short description and description of
 * the published revision, per locale. Offers: the description of each published Offer, per
 * locale. Catalog tables only. Runs in a read-only unit the caller opens and closes before it
 * calls `certification` (units do not nest).
 */
export interface ClaimTextImpactReader {
  page(
    market: MarketContext,
    query: {
      readonly kind: ImpactTextKind;
      readonly afterId: string | null;
      readonly limit: number;
    },
  ): Promise<ImpactTextPage>;
}

export const CLAIM_TEXT_IMPACT_READER = Symbol('CATALOG_CLAIM_TEXT_IMPACT_READER');
