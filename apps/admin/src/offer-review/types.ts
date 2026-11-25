// Answers and keys of the admin Offer review queue (catalog, risk-based Offer approval slice 5;
// ADR-0051). Ids, codes and the seller's own content only; the panel follows what the API answers
// and decides nothing. Reason codes are the API's (`OFFER_REVIEW_REASONS`).

export const VIEW_PERMISSION = 'catalog.product.view';
export const DECIDE_PERMISSION = 'catalog.product.approve';
export const OFFERS_PATH = '/offer-reviews';

export const API_QUEUE = 'catalog/admin/review-queue';
export const API_CHANGES = 'catalog/admin/offer-changes';
export const API_STOPS = 'catalog/admin/offer-review/stops';

/** The reason codes of a held Offer, with the letter code the reviewers know them by. */
export const REVIEW_REASONS = [
  'emergency-stop',
  'probation',
  'certificate-badge',
  'handling',
  'contact-text',
  'full-review',
  'sensitive-category',
  'review-all',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

const KNOWN: ReadonlySet<string> = new Set(REVIEW_REASONS);
export const isKnownReason = (code: string): code is ReviewReason => KNOWN.has(code);

/** Reasons a bulk approval may carry (Hadi's decision 3): R1, R6, and R2 under one seller and type. */
export const BULK_REASONS: ReadonlySet<string> = new Set([
  'probation',
  'full-review',
  'certificate-badge',
]);

/** The reasons drawn in the danger tone (R0 and R2); text always shows next to the tone. */
export const DANGER_REASONS: ReadonlySet<string> = new Set(['emergency-stop', 'certificate-badge']);

export const NOTE_MAX = 2000;

export type QueueTab = 'first' | 'edits';
export const parseTab = (
  raw: Readonly<Record<string, string | readonly string[] | undefined>>,
): QueueTab => (raw['tab'] === 'edits' ? 'edits' : 'first');
export const tabHref = (tab: QueueTab): string =>
  tab === 'edits' ? `${OFFERS_PATH}?tab=edits` : OFFERS_PATH;
export const changeHref = (changeId: string): string => `${OFFERS_PATH}/${changeId}`;

/** An Offer waiting for its first publication (apps/api ReviewQueueRowDto). */
export interface FirstRow {
  readonly kind: 'offer-first-publication';
  readonly offerId: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  readonly storeName: string | null;
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
  readonly reasons: readonly string[];
  readonly tagTypes: readonly string[];
  readonly submittedAt: string | null;
  readonly actions: readonly string[];
}

export interface ChangeLive {
  readonly description: Readonly<Record<string, string>>;
  readonly handling: string | null;
  readonly tagTypes: readonly string[];
}

/** A held edit of a live Offer (apps/api OfferChangeListItemDto). */
export interface ChangeRow {
  readonly changeId: string;
  readonly offerId: string;
  readonly status: string;
  readonly fields: readonly string[];
  readonly proposedDescription: Readonly<Record<string, string>> | null;
  readonly proposedHandling: string | null;
  readonly proposedTagTypes: readonly string[];
  readonly baseOfferVersion: number;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly supersededCause: string | null;
  readonly reasons: readonly string[];
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly offer: {
    readonly productId: string;
    readonly sellerSku: string;
    readonly conditionCode: string;
    readonly status: string;
    readonly version: number;
  } | null;
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    readonly name: string | null;
  };
  readonly live: ChangeLive | null;
  readonly actions: readonly string[];
}

export interface ChangesAnswer {
  readonly totalPending: number;
}

/** The row's product label: its name, else its code, else the SKU. */
export const firstName = (row: FirstRow): string =>
  row.product.name ?? row.product.productCode ?? row.sellerSku;
export const changeName = (row: ChangeRow): string =>
  row.product.name ?? row.product.productCode ?? row.offer?.sellerSku ?? row.offerId;

/** What the bulk approval check found: allowed, or the reason it is not. */
export type BulkCheck =
  | { readonly ok: true; readonly certificate: string | null; readonly sellerId: string | null }
  | {
      readonly ok: false;
      readonly why: 'reasons' | 'certificate-mixed';
      /** The rows that need a person (why `reasons`), to be named; none for a mixed certificate. */
      readonly rows: readonly FirstRow[];
    };

/**
 * Whether the ticked first publications may be approved together: every row carries only bulk-able
 * reasons, and the rows with a certificate badge to check (R2) share one seller and one certificate
 * type. This only tells the reviewer why before asking; the server enforces the same rule and skips
 * what it refuses.
 */
export function bulkApprovalCheck(rows: readonly FirstRow[]): BulkCheck {
  const blocked = rows.filter(
    (row) => row.reasons.length === 0 || row.reasons.some((reason) => !BULK_REASONS.has(reason)),
  );
  if (blocked.length > 0) return { ok: false, why: 'reasons', rows: blocked };
  const badge = rows.filter((row) => row.reasons.includes('certificate-badge'));
  if (badge.length === 0) return { ok: true, certificate: null, sellerId: null };
  const sellers = new Set(badge.map((row) => row.sellerId));
  const types = new Set(badge.flatMap((row) => row.tagTypes));
  if (sellers.size > 1 || types.size > 1) {
    return { ok: false, why: 'certificate-mixed', rows: [] };
  }
  return { ok: true, certificate: [...types][0] ?? null, sellerId: [...sellers][0] ?? null };
}

/** The stops answer (GET catalog/admin/offer-review/stops); a part that was not read is null. */
export interface Stops {
  readonly marketStop: boolean | null;
  readonly stoppedSellers: number | null;
  readonly stoppedCategories: number | null;
  readonly active: boolean;
}

export function stopsOf(body: unknown): Stops | null {
  if (typeof body !== 'object' || body === null) return null;
  const { marketStop, stoppedSellers, stoppedCategories, active } = body as Record<string, unknown>;
  if (typeof active !== 'boolean') return null;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  return {
    marketStop: typeof marketStop === 'boolean' ? marketStop : null,
    stoppedSellers: count(stoppedSellers),
    stoppedCategories: count(stoppedCategories),
    active,
  };
}

/** A certification type code as words ("gluten-free" -> "Gluten free"); the code comes from the API. */
export const typeLabel = (code: string): string => {
  const words = code.replace(/[-_]+/g, ' ').trim();
  return words === '' ? code : words.charAt(0).toUpperCase() + words.slice(1);
};
