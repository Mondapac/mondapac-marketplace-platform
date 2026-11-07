// Answers of GET catalog/admin/review-queue (apps/api offer-review.dto.ts). Ids, codes and the
// seller's own Offer content only.

export const VIEW_PERMISSION = 'catalog.product.view';
export const DECIDE_PERMISSION = 'catalog.product.approve';
export const PAGE_SIZE = 25;
export const CHANGE_REASONS = [
  'content-unclear',
  'description-claim',
  'sku-or-condition',
  'handling-unclear',
  'other',
] as const;

export interface ReviewRow {
  readonly kind: 'offer-first-publication';
  readonly offerId: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  readonly productId: string;
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    readonly name: string | null;
  };
  readonly sellerSku: string;
  readonly conditionCode: string;
  readonly description: Readonly<Record<string, string>>;
  readonly handling: string | null;
  readonly submittedAt: string | null;
}

/**
 * A pending product revision. The same queue answer carries these next to the Offer rows; this
 * page leaves them out (the planned product version review screen will show them), so only the
 * kind is read.
 */
export interface RevisionQueueRow {
  readonly kind: 'product-revision';
}

export interface ReviewPage {
  readonly items: readonly (ReviewRow | RevisionQueueRow)[];
  readonly nextAfterId: string | null;
}

/** The Offer rows of a queue page, in queue order; product revision rows are left out. */
export function offerRowsOf(items: ReviewPage['items']): readonly ReviewRow[] {
  return items.filter((row): row is ReviewRow => row.kind === 'offer-first-publication');
}
