import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { authorLabel } from '../domain/author';
import { windowEndsAt } from '../domain/rules';
import {
  averageTimes100,
  shareBps,
  summaryShownFrom,
  type SellerSummary,
  type StarSummary,
} from '../domain/summary';
import type { ProductRatingSummary, SellerRatingSummary } from '../contracts/reviews.facade';
import { buyerAccountId } from './caller';
import { activeSettings } from './market-switch';
import type { FieldIssue, ReviewsFailure, SummaryFailure } from './failures';
import type { PublishedReviewRecord, ReviewCursor } from './ports/review.repository';
import { deliveredPurchases, lookbackSince } from './purchases';
import type { ReviewsDependencies } from './reviews-dependencies';
import {
  ownReviewView,
  ownSellerRatingView,
  type OwnReviewView,
  type OwnSellerRatingView,
  type PublicReviewView,
} from './views';

// The reads: the buyer's own (what is left to review, what they wrote) and the public ones
// (published reviews of a product, the product and seller summaries). Every read answers
// `reviews.disabled` while reviews are off in the Market. Summaries come from the rebuilt table;
// a subject with no row has no ratings.

const MY_LIST_LIMIT = 100;

const dayOf = (instant: Temporal.Instant): string => instant.toString().slice(0, 10);

const denied = err({ code: 'access.denied' } as const);

// ---- what is left to review -------------------------------------------------------------------

export interface ToReviewProduct {
  readonly productId: Id<'Product'>;
  /** The latest delivered purchase of the product: the "Bought from" offer and seller. */
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly deliveredAt: Temporal.Instant;
  readonly windowEndsAt: Temporal.Instant;
}

export interface ToReviewSellerOrder {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly deliveredAt: Temporal.Instant;
  readonly windowEndsAt: Temporal.Instant;
}

export interface ToReviewView {
  readonly products: readonly ToReviewProduct[];
  readonly sellerOrders: readonly ToReviewSellerOrder[];
}

export async function listToReview(
  deps: ReviewsDependencies,
  context: CallContext,
): Promise<Result<ToReviewView, ReviewsFailure>> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const now = deps.clock.now();

  // Only deliveries still inside the window are listed; the lookback of the purchase lookup is
  // wider and is filtered here.
  const purchases = await deliveredPurchases(
    deps,
    context,
    { since: lookbackSince(now, settings) },
    true,
  );
  if (!purchases.ok) return purchases;
  const open = (deliveredAt: Temporal.Instant) => {
    const ends = windowEndsAt(deliveredAt, settings.reviewWindowDays);
    return (
      Temporal.Instant.compare(now, deliveredAt) >= 0 && Temporal.Instant.compare(now, ends) <= 0
    );
  };

  const latest = new Map<Id<'Product'>, (typeof purchases.value.candidates)[number]>();
  for (const candidate of purchases.value.candidates) {
    if (!open(candidate.deliveredAt)) continue;
    const known = latest.get(candidate.productId);
    if (
      known === undefined ||
      candidate.deliveredAt.epochMilliseconds > known.deliveredAt.epochMilliseconds
    ) {
      latest.set(candidate.productId, candidate);
    }
  }
  const inWindowOrders = purchases.value.orders.filter((order) => open(order.deliveredAt));

  const state = await deps.unitOfWork.run(
    context.market,
    async () =>
      ok({
        reviewed: await deps.reviews.reviewedProductIds(context.market, accountId, [
          ...latest.keys(),
        ]),
        rated: await deps.reviews.ratedSellerOrderIds(
          context.market,
          accountId,
          inWindowOrders.map((order) => order.sellerOrderId),
        ),
      }),
    { readOnly: true },
  );
  if (!state.ok) return err({ code: 'reviews.unavailable' });

  return ok({
    products: [...latest.values()]
      .filter((candidate) => !state.value.reviewed.has(candidate.productId))
      .sort((a, b) => b.deliveredAt.epochMilliseconds - a.deliveredAt.epochMilliseconds)
      .map((candidate) => ({
        productId: candidate.productId,
        offerId: candidate.offerId,
        sellerId: candidate.sellerId,
        sellerOrderId: candidate.sellerOrderId,
        deliveredAt: candidate.deliveredAt,
        windowEndsAt: windowEndsAt(candidate.deliveredAt, settings.reviewWindowDays),
      })),
    sellerOrders: inWindowOrders
      .filter((order) => !state.value.rated.has(order.sellerOrderId))
      .map((order) => ({
        sellerOrderId: order.sellerOrderId,
        sellerId: order.sellerId,
        deliveredAt: order.deliveredAt,
        windowEndsAt: windowEndsAt(order.deliveredAt, settings.reviewWindowDays),
      })),
  });
}

// ---- what the buyer wrote ---------------------------------------------------------------------

export interface MyReviewsView {
  readonly reviews: readonly OwnReviewView[];
  readonly sellerRatings: readonly OwnSellerRatingView[];
}

export async function listMyReviews(
  deps: ReviewsDependencies,
  context: CallContext,
): Promise<Result<MyReviewsView, ReviewsFailure>> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const read = await deps.unitOfWork.run(
    context.market,
    async () =>
      ok({
        reviews: await deps.reviews.listOwnProductReviews(context.market, accountId, MY_LIST_LIMIT),
        ratings: await deps.reviews.listOwnSellerRatings(context.market, accountId, MY_LIST_LIMIT),
      }),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'reviews.unavailable' });
  return ok({
    reviews: read.value.reviews.map((record) => ownReviewView(record, settings.editWindowDays)),
    sellerRatings: read.value.ratings.map(ownSellerRatingView),
  });
}

// ---- the public list of a product -------------------------------------------------------------

export interface ListProductReviewsInput {
  readonly productId?: unknown;
  readonly stars?: unknown;
  readonly sort?: unknown;
  readonly cursor?: unknown;
}

export interface ProductReviewsPage {
  readonly reviews: readonly PublicReviewView[];
  readonly nextCursor: string | null;
}

// The cursor of the public list is the random public id of the last review shown: it carries no
// time (an exact publish time would let a client binary-search it), and an id of another product
// or a made-up one is refused.
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function listProductReviews(
  deps: ReviewsDependencies,
  context: CallContext,
  input: ListProductReviewsInput,
): Promise<Result<ProductReviewsPage, ReviewsFailure>> {
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;

  const fields: FieldIssue[] = [];
  const productId =
    typeof input?.productId === 'string' ? parseId<'Product'>(input.productId) : null;
  if (productId === null || !productId.ok) fields.push({ path: 'productId', code: 'format' });
  let stars: number | null = null;
  if (input?.stars !== undefined) {
    const parsed =
      typeof input.stars === 'string' && /^[1-5]$/.test(input.stars) ? Number(input.stars) : null;
    if (parsed === null) fields.push({ path: 'stars', code: 'range' });
    else stars = parsed;
  }
  // "Most helpful" arrives with helpful votes (not in this package): only `recent` exists.
  if (input?.sort !== undefined && input.sort !== 'recent')
    fields.push({ path: 'sort', code: 'value' });
  let cursorId: string | null = null;
  if (input?.cursor !== undefined) {
    if (typeof input.cursor === 'string' && PUBLIC_ID.test(input.cursor)) cursorId = input.cursor;
    else fields.push({ path: 'cursor', code: 'format' });
  }
  if (fields.length > 0 || productId === null || !productId.ok) {
    return err({ code: 'validation.failed', fields });
  }

  const read = await deps.unitOfWork.run<readonly PublishedReviewRecord[], ReviewsFailure>(
    context.market,
    async () => {
      let after: ReviewCursor | null = null;
      if (cursorId !== null) {
        after = await deps.reviews.findPublicCursor(context.market, productId.value, cursorId);
        // An id that is not a review of this product is a forged or stale cursor.
        if (after === null) {
          return err({
            code: 'validation.failed',
            fields: [{ path: 'cursor', code: 'format' }],
          } as const);
        }
      }
      return ok(
        await deps.reviews.listPublishedProductReviews(context.market, productId.value, {
          stars,
          after,
          limit: settings.pageSize + 1,
        }),
      );
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const page = read.value.slice(0, settings.pageSize);

  // Names are read now and never stored; an author who chose to be anonymous is not even asked.
  const named = [
    ...new Set(
      page.flatMap((record) =>
        record.accountId === null || record.anonymous ? [] : [record.accountId],
      ),
    ),
  ];
  let names: ReadonlyMap<Id<'Account'>, string> = new Map();
  if (named.length > 0) {
    try {
      names = await deps.names.shortNames(context, named);
    } catch {
      // A name source that fails leaves the authors as "Verified buyer"; the list still shows.
      names = new Map();
    }
  }
  const last = page[page.length - 1];
  return ok({
    reviews: page.map((record) => ({
      id: record.publicId,
      rating: record.rating,
      title: record.title,
      body: record.body,
      locale: record.locale,
      author: authorLabel(
        record,
        record.accountId === null ? undefined : names.get(record.accountId),
      ),
      boughtFrom: { offerId: record.offerId, sellerId: record.sellerId },
      publishedOn: dayOf(record.publishedAt!),
      editedOn: record.editedAt === null ? null : dayOf(record.editedAt),
    })),
    nextCursor: read.value.length > settings.pageSize && last !== undefined ? last.publicId : null,
  });
}

// ---- summaries --------------------------------------------------------------------------------

const NO_STARS: StarSummary = { count: 0, sum: 0, histogram: [0, 0, 0, 0, 0] };

export async function viewProductSummary(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly productId?: unknown },
): Promise<Result<ProductRatingSummary, SummaryFailure>> {
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const productId =
    typeof input?.productId === 'string' ? parseId<'Product'>(input.productId) : null;
  if (productId === null || !productId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'productId', code: 'format' }] });
  }
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.reviews.readProductSummary(context.market, productId.value)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'reviews.unavailable' });
  const summary: StarSummary = read.value ?? NO_STARS;
  return ok({
    productId: productId.value,
    count: summary.count,
    averageTimes100: averageTimes100(summary),
    histogram: summary.histogram,
    shown: summaryShownFrom(summary.count, 1),
  });
}

export async function viewSellerSummary(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly sellerId?: unknown },
): Promise<Result<SellerRatingSummary, SummaryFailure>> {
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const sellerId = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
  if (sellerId === null || !sellerId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.reviews.readSellerSummary(context.market, sellerId.value)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'reviews.unavailable' });
  const summary: SellerSummary = read.value ?? {
    ...NO_STARS,
    ratedSellerOrders: 0,
    satisfiedCount: 0,
    asDescribedYes: 0,
    arrivedOkYes: 0,
  };
  const meetsMinimum = summaryShownFrom(summary.ratedSellerOrders, settings.sellerRatingMinCount);
  // Below the Market minimum only the count is given: the endpoint is public, and a summary of a
  // few ratings would show the seller what one buyer answered.
  return ok({
    sellerId: sellerId.value,
    count: summary.ratedSellerOrders,
    minimumCount: settings.sellerRatingMinCount,
    meetsMinimum,
    averageTimes100: meetsMinimum ? averageTimes100(summary) : null,
    histogram: meetsMinimum ? summary.histogram : null,
    satisfiedBps: meetsMinimum ? shareBps(summary.satisfiedCount, summary.ratedSellerOrders) : null,
    asDescribedBps: meetsMinimum
      ? shareBps(summary.asDescribedYes, summary.ratedSellerOrders)
      : null,
    arrivedOkBps: meetsMinimum ? shareBps(summary.arrivedOkYes, summary.ratedSellerOrders) : null,
  });
}
