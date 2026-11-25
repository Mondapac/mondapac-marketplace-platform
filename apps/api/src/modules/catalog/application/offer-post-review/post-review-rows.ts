import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  heldKeys,
  parseNamedInstantRange,
  type PermissionProbe,
} from '../../../../platform/list-query';
import { CATALOG_PRODUCT_APPROVE, CATALOG_PRODUCT_DELETE } from '../../contracts/permissions';
import type { OfferChangeReason } from '../../domain/events';
import type { Offer, OfferStatus } from '../../domain/offer';
import {
  OFFER_POST_REVIEW_REASONS,
  OFFER_POST_REVIEW_STATUSES,
  type OfferPostReview,
  type OfferPostReviewReason,
  type OfferPostReviewStatus,
} from '../../domain/offer-post-review';
import type { OfferPostReviewFilter } from '../ports/offer-post-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import type { ValidationFailure } from '../own-reads/own-reads.shared';
import { parseQueueSearch } from '../use-cases/review-queue-list.use-case';

/**
 * One row of the post-publication review list (slice 6) as the admin panel shows it. Codes and
 * labels only: no price, no median, and never the note (only the single read adds it).
 */
export interface AdminOfferPostReviewRow {
  readonly id: string;
  readonly version: number;
  readonly status: OfferPostReviewStatus;
  readonly reasons: readonly OfferPostReviewReason[];
  readonly samplePercent: number | null;
  readonly sampleDoubled: boolean;
  readonly openedAt: string;
  readonly decidedAt: string | null;
  readonly decision: {
    readonly reasonCode: OfferChangeReason | null;
    readonly misconduct: boolean | null;
  } | null;
  /** The Offer now; null only if it cannot be read. */
  readonly offer: {
    readonly id: string;
    readonly status: OfferStatus;
    readonly listed: boolean;
    readonly sellerSku: string;
  } | null;
  readonly product: { readonly id: string; readonly name: string | null };
  readonly sellerId: string;
  /** The seller's public store name; null when `sellers` cannot say. */
  readonly storeName: string | null;
  /** What the caller may do now (the use cases check again). */
  readonly actions: { readonly approve: boolean; readonly takeDown: boolean };
}

export interface PostReviewRowsDependencies {
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly sellerNames: SellerNamesReader;
  readonly productApproveProbe: PermissionProbe;
  readonly deleteProbe: PermissionProbe;
}

/** What the unit reads for a page of rows: the Offers now and their product labels. */
export interface PostReviewRowFacts {
  readonly offers: ReadonlyMap<string, Offer>;
  readonly names: ReadonlyMap<string, string | null>;
}

/** Inside the caller's read-only unit: the Offers of the rows and their products' names. */
export async function readPostReviewRowFacts(
  deps: Pick<PostReviewRowsDependencies, 'offers' | 'ownReader'>,
  market: MarketContext,
  reviews: readonly OfferPostReview[],
  locale: string,
): Promise<PostReviewRowFacts> {
  const offerIds = [...new Set(reviews.map((review) => review.state.offerId))];
  const offers = offerIds.length === 0 ? [] : await deps.offers.findManyByIds(market, offerIds);
  const productIds = [
    ...new Set([
      ...offers.map((offer) => offer.state.productId),
      ...reviews.map((review) => review.state.productId),
    ]),
  ];
  const labels =
    productIds.length === 0 ? [] : await deps.ownReader.productLabels(market, productIds, locale);
  return {
    offers: new Map(offers.map((offer) => [offer.state.id, offer])),
    names: new Map(labels.map((label) => [label.productId, label.name])),
  };
}

/** The keys behind the row actions: Approve needs the approve key, Take down also the delete key. */
export async function postReviewKeys(
  deps: Pick<PostReviewRowsDependencies, 'productApproveProbe' | 'deleteProbe'>,
  context: CallContext,
): Promise<{ readonly approve: boolean; readonly takeDown: boolean }> {
  const held = await heldKeys(context, {
    [CATALOG_PRODUCT_APPROVE.key]: deps.productApproveProbe,
    [CATALOG_PRODUCT_DELETE.key]: deps.deleteProbe,
  });
  const approve = held.has(CATALOG_PRODUCT_APPROVE.key);
  return { approve, takeDown: approve && held.has(CATALOG_PRODUCT_DELETE.key) };
}

/** After the unit: the store names, then one row per review. */
export async function postReviewRows(
  deps: Pick<PostReviewRowsDependencies, 'sellerNames'>,
  context: CallContext,
  reviews: readonly OfferPostReview[],
  facts: PostReviewRowFacts,
  keys: { readonly approve: boolean; readonly takeDown: boolean },
): Promise<AdminOfferPostReviewRow[]> {
  const sellerIds = [...new Set(reviews.map((review) => review.state.sellerId))];
  let names = new Map<string, string>() as ReadonlyMap<string, string>;
  if (sellerIds.length > 0) {
    try {
      names = await deps.sellerNames.storeNames(context, sellerIds);
    } catch {
      // A store name that cannot be read is null; the rows still show.
    }
  }
  return reviews.map((review) => postReviewRowOf(review, facts, names, keys));
}

export function postReviewRowOf(
  review: OfferPostReview,
  facts: PostReviewRowFacts,
  names: ReadonlyMap<string, string>,
  keys: { readonly approve: boolean; readonly takeDown: boolean },
): AdminOfferPostReviewRow {
  const state = review.state;
  const offer = facts.offers.get(state.offerId) ?? null;
  const productId = offer?.state.productId ?? state.productId;
  const open = state.status === 'open';
  return {
    id: state.id,
    version: state.version,
    status: state.status,
    reasons: [...state.reasons],
    samplePercent: state.samplePercent,
    sampleDoubled: state.sampleDoubled,
    openedAt: state.openedAt.toString(),
    decidedAt: state.decidedAt === null ? null : state.decidedAt.toString(),
    decision:
      state.status === 'open'
        ? null
        : { reasonCode: state.decisionReasonCode, misconduct: state.misconduct },
    offer:
      offer === null
        ? null
        : {
            id: offer.state.id,
            status: offer.state.status,
            listed: offer.state.listed,
            sellerSku: offer.state.sellerSku,
          },
    product: { id: productId, name: facts.names.get(productId) ?? null },
    sellerId: state.sellerId,
    storeName: names.get(state.sellerId) ?? null,
    actions: {
      approve: open && keys.approve,
      takeDown: open && keys.takeDown && offer?.state.status === 'published',
    },
  };
}

/** The list's filter keys (and its export's). */
export const OFFER_POST_REVIEWS_FILTER_KEYS = [
  'status',
  'reasons',
  'sellerId',
  'categoryId',
  'openedFrom',
  'openedTo',
  'q',
] as const;

/** The status views: one status, or `all`; absent is `open`. */
export const OFFER_POST_REVIEW_VIEWS = [...OFFER_POST_REVIEW_STATUSES, 'all'] as const;

export interface ParsedPostReviewFilter extends Omit<OfferPostReviewFilter, 'search'> {
  readonly text: string | null;
}

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';
const invalid = (path: string, code: string) =>
  err({ code: 'validation.failed', fields: [{ path, code }] } as const);

/** The `reasons` filter: an array or one comma-separated text of known reason codes; any of them. */
export function parsePostReviewReasons(
  value: unknown,
): Result<readonly OfferPostReviewReason[] | null, ValidationFailure> {
  if (absent(value)) return ok(null);
  const raw =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? (value as unknown[])
        : null;
  if (raw === null || raw.length === 0 || raw.length > OFFER_POST_REVIEW_REASONS.length * 2) {
    return invalid('reasons', 'type');
  }
  const picked = new Set<OfferPostReviewReason>();
  for (const item of raw) {
    const known = OFFER_POST_REVIEW_REASONS.find((reason) => reason === item);
    if (known === undefined) return invalid('reasons', 'value');
    picked.add(known);
  }
  return ok([...picked]);
}

/** The filters of the list and its export, checked (closed values; unknown keys are the caller's). */
export function parsePostReviewFilter(
  record: Readonly<Record<string, unknown>>,
): Result<ParsedPostReviewFilter, ValidationFailure> {
  const view = absent(record['status']) ? 'open' : record['status'];
  const status = OFFER_POST_REVIEW_VIEWS.find((known) => known === view);
  if (status === undefined) return invalid('status', 'value');
  const reasons = parsePostReviewReasons(record['reasons']);
  if (!reasons.ok) return reasons;
  const ids: { sellerId?: Id<'Seller'>; categoryId?: Id<'Category'> } = {};
  for (const key of ['sellerId', 'categoryId'] as const) {
    if (absent(record[key])) continue;
    const parsed = typeof record[key] === 'string' ? parseId(record[key]) : null;
    if (parsed === null || !parsed.ok) return invalid(key, 'format');
    (ids as Record<string, unknown>)[key] = parsed.value;
  }
  const opened = parseNamedInstantRange(record, 'openedFrom', 'openedTo');
  if (!opened.ok) return opened;
  const text = parseQueueSearch(record['q']);
  if (!text.ok) return text;
  return ok({
    ...(status === 'all' ? {} : { status }),
    ...(reasons.value === null ? {} : { reasons: reasons.value }),
    ...ids,
    openedFrom: opened.value.from,
    openedTo: opened.value.to,
    text: text.value,
  });
}
