// Answers and keys of the post-publication review list (catalog, risk-based Offer approval slice 6;
// ADR-0051). Ids, codes and labels only: the list never carries a price, a median or the decision
// note (the note comes with one row's read, for an admin holding the approve key).

export const API_POST_REVIEWS = 'catalog/admin/offer-post-reviews';

/** Approve needs the approve key; Take down needs it and the delete key (the Offer goes off sale). */
export const POST_APPROVE_PERMISSION = 'catalog.product.approve';
export const TAKE_DOWN_PERMISSIONS = ['catalog.product.approve', 'catalog.product.delete'] as const;

/** Why a published Offer is in the list (`reasons` of a row; the API's CHECK of four codes). */
export const POST_REVIEW_REASONS = [
  'sample',
  'price-no-reference',
  'price-reference-unavailable',
  'price-recheck-outside',
] as const;
export type PostReviewReason = (typeof POST_REVIEW_REASONS)[number];
const KNOWN: ReadonlySet<string> = new Set(POST_REVIEW_REASONS);
export const isPostReviewReason = (code: string): code is PostReviewReason => KNOWN.has(code);

/** The list's views (`status` of the route); Open is the default. */
export const POST_REVIEW_VIEWS = ['open', 'approved', 'taken-down', 'all'] as const;
export type PostReviewStatus = 'open' | 'approved' | 'taken-down';

/** The note of a take-down (required) or an approval (optional): 1 to 2000 characters. */
export const POST_NOTE_MAX = 2000;

/** One row of GET catalog/admin/offer-post-reviews (and of `/:id`, which adds `note`). */
export interface PostReviewRow {
  readonly id: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly status: PostReviewStatus;
  readonly reasons: readonly string[];
  /** The effective sampling percent (after doubling) when the row is a sample; else null. */
  readonly samplePercent: number | null;
  /** The sample was drawn at the doubled rate of a seller Trusted for less than 30 days. */
  readonly sampleDoubled: boolean;
  readonly openedAt: string;
  readonly decidedAt: string | null;
  readonly decision: { readonly reasonCode: string | null; readonly misconduct: boolean } | null;
  readonly offer: {
    readonly id: string;
    readonly status: string;
    readonly listed: boolean;
    readonly sellerSku: string;
  };
  readonly product: { readonly id: string; readonly name: string | null };
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly actions: { readonly approve: boolean; readonly takeDown: boolean };
  /** Only on the one-row read, for an admin holding the approve key. */
  readonly note?: string | null;
}

/** The row's product label: its name, else the SKU. */
export const postReviewName = (row: PostReviewRow): string =>
  row.product.name ?? row.offer.sellerSku;

/**
 * The chips of a row, in the order the API gave the reasons: a sample drawn at the doubled rate
 * shows as "Sample ×2" instead of "Sample". A code this panel does not know is kept as it came.
 */
export const reasonChipKeys = (row: Pick<PostReviewRow, 'reasons' | 'sampleDoubled'>) =>
  row.reasons.map((code) =>
    code === 'sample' && row.sampleDoubled
      ? { code, key: 'sample-doubled' as const }
      : { code, key: isPostReviewReason(code) ? code : null },
  );
