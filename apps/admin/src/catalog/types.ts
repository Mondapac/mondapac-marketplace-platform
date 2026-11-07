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
 * A pending product revision as the dashboard reads it: the same queue answer carries these next
 * to the Offer rows, and the Offer views leave them out, so only the kind is read.
 */
export interface RevisionQueueRow {
  readonly kind: 'product-revision';
}

/** A pending product revision row of the queue (apps/api ProductRevisionRowDto). */
export interface RevisionRow {
  readonly kind: 'product-revision';
  readonly productId: string;
  /** The pending revision a decision must name. */
  readonly revisionId: string;
  readonly revisionNo: number;
  /** The product version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    readonly name: string | null;
  };
  readonly firstPublication: boolean;
  /** What changed, as classification codes (REVISION_REASONS). */
  readonly reasons: readonly string[];
  /** The named checks an approval must confirm. */
  readonly requiredChecks: readonly string[];
  readonly hasImages: boolean;
  readonly warnings: readonly string[];
  readonly submittedAt: string;
}

/** The classification codes of a revision (apps/api SENSITIVE_REASONS); others show as code. */
export const REVISION_REASONS = [
  'platform-categories',
  'tax-category',
  'name',
  'primary-image',
  'image-added-or-replaced',
  'variant-removed',
  'gtin-changed',
  'never-published',
  'approval-required',
] as const;

/** GET catalog/admin/review-queue with `kind`: one kind's page, and the whole queue per kind. */
export interface QueuePage<Row> {
  readonly items: readonly Row[];
  readonly nextAfterId: string | null;
  /** The rows the filters keep. */
  readonly total: number;
  /** Every row of each kind, whatever the filters: the tab counts. */
  readonly totals: {
    readonly 'product-revision': number;
    readonly 'offer-first-publication': number;
  };
}

export interface ReviewPage {
  readonly items: readonly (ReviewRow | RevisionQueueRow)[];
  readonly nextAfterId: string | null;
}

/** The Offer rows of a queue page, in queue order; product revision rows are left out. */
export function offerRowsOf(items: ReviewPage['items']): readonly ReviewRow[] {
  return items.filter((row): row is ReviewRow => row.kind === 'offer-first-publication');
}
