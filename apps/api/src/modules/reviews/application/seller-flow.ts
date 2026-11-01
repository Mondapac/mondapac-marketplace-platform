import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  canEditReply,
  canReplyToStatus,
  validateReplyInput,
  validateReportReason,
} from '../domain/seller-reply';
import { checkText } from '../domain/text-checks';
import { isActingAs } from './caller';
import type { ReviewsFailure } from './failures';
import { activeSettings } from './market-switch';
import type { ProductReviewRecord, ReplyRecord, ReviewCursor } from './ports/review.repository';
import type { ReviewsDependencies } from './reviews-dependencies';

// The seller's side of reviews (buyer reviews and ratings package 4; owner decision N6, design 5.2
// and 6). A shop lists its own published reviews, writes ONE public reply to each, edits it for a
// Market-set number of days and reports a review with a reason code. It never hides or removes a
// review. A seller never sees the buyer: only the order reference. The text of a review or a reply
// is never logged, audited, evented or put in a failure.

const denied = err({ code: 'access.denied' } as const);

/** The seller of an authenticated seller session; null for anyone else (fail closed). */
function sellerOf(context: CallContext): Id<'Seller'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  const parsed = typeof actor.sellerId === 'string' ? parseId<'Seller'>(actor.sellerId) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** Writes are refused in an acting-as session: support may look at a shop, never speak for it. */
function writingSeller(
  context: CallContext,
): { sellerId: Id<'Seller'>; accountId: Id<'Account'> } | null {
  const sellerId = sellerOf(context);
  const actor = context.actor;
  if (sellerId === null || isActingAs(context) || actor.kind !== 'authenticated') return null;
  return { sellerId, accountId: actor.accountId };
}

export interface SellerReplyView {
  readonly body: string;
  readonly createdAt: Temporal.Instant;
  readonly editedAt: Temporal.Instant | null;
  /** After this instant the reply can no longer be edited. */
  readonly editableUntil: Temporal.Instant;
}

export interface SellerReviewView {
  readonly id: Id<'ProductReview'>;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  /** The seller order of the latest qualifying purchase: the only thing that names the buyer. */
  readonly orderRef: Id<'SellerOrder'> | null;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly publishedAt: Temporal.Instant | null;
  readonly reply: SellerReplyView | null;
}

const replyView = (reply: ReplyRecord, days: number): SellerReplyView => ({
  body: reply.body,
  createdAt: reply.createdAt,
  editedAt: reply.editedAt,
  editableUntil: reply.createdAt.add({ hours: days * 24 }),
});

const reviewView = (
  row: {
    review: ProductReviewRecord;
    reply: ReplyRecord | null;
  },
  days: number,
): SellerReviewView => ({
  id: row.review.id,
  productId: row.review.productId,
  offerId: row.review.offerId,
  orderRef: row.review.lastSellerOrderId,
  rating: row.review.rating,
  title: row.review.title,
  body: row.review.body,
  locale: row.review.locale,
  publishedAt: row.review.publishedAt,
  reply: row.reply === null || row.reply.status !== 'published' ? null : replyView(row.reply, days),
});

// ---- list -------------------------------------------------------------------------------------

const CURSOR = /^(\d{1,15})_([0-9a-f-]{36})$/;
const encodeCursor = (c: ReviewCursor): string => `${c.publishedAt.epochMilliseconds}_${c.id}`;
function decodeCursor(raw: string): ReviewCursor | null {
  const match = CURSOR.exec(raw);
  if (match === null) return null;
  const id = parseId<'ProductReview'>(match[2]!);
  return id.ok
    ? { publishedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value }
    : null;
}

export interface SellerReviewsPage {
  readonly items: readonly SellerReviewView[];
  readonly nextCursor: string | null;
}

export async function listSellerReviews(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly cursor?: unknown },
): Promise<Result<SellerReviewsPage, ReviewsFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  let after: ReviewCursor | null = null;
  if (input?.cursor !== undefined) {
    after = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : null;
    if (after === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'cursor', code: 'format' }] });
    }
  }
  const limit = settings.pageSize;
  return deps.unitOfWork.run<SellerReviewsPage, ReviewsFailure>(
    context.market,
    async () => {
      const rows = await deps.reviews.listSellerReviews(context.market, sellerId, {
        after,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return ok({
        items: page.map((row) => reviewView(row, settings.replyEditWindowDays)),
        nextCursor:
          rows.length > limit && last !== undefined && last.review.publishedAt !== null
            ? encodeCursor({ publishedAt: last.review.publishedAt, id: last.review.id })
            : null,
      });
    },
    { readOnly: true },
  );
}

// ---- reply and edit ---------------------------------------------------------------------------

const parseReviewId = (value: unknown) => {
  const parsed = typeof value === 'string' ? parseId<'ProductReview'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/**
 * Writes the shop's reply (`mode: 'create'`) or changes it (`'edit'`). A reply to a review that
 * is not published, or that is not the shop's, is `reviews.not-found`. Contact details, links,
 * markup and the Market's blocked words are refused in a reply (a field problem, never echoed).
 */
export async function writeReply(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly reviewId?: unknown; readonly body?: unknown },
  mode: 'create' | 'edit',
): Promise<Result<SellerReviewView, ReviewsFailure>> {
  const seller = writingSeller(context);
  if (seller === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const reviewId = parseReviewId(input?.reviewId);
  if (reviewId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'reviewId', code: 'format' }] });
  }
  const content = validateReplyInput(input, { bodyMaxLength: settings.replyMaxLength });
  if (!content.ok) return err({ code: 'validation.failed', fields: content.error });
  if (checkText({ title: null, body: content.value }, settings.textRules).length > 0) {
    return err({ code: 'validation.failed', fields: [{ path: 'body', code: 'not-allowed' }] });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<SellerReviewView, ReviewsFailure>(context.market, async () => {
    // Lock the review first: a concurrent move or re-post waits for this unit, so the reply can
    // never be written beside a review that has just left the shop.
    if (!(await deps.reviews.lockPublishedReviewOf(context.market, seller.sellerId, reviewId))) {
      return err({ code: 'reviews.not-found' });
    }
    const found = await deps.reviews.findSellerReview(context.market, seller.sellerId, reviewId);
    if (found === null || !canReplyToStatus(found.review.status)) {
      return err({ code: 'reviews.not-found' });
    }
    if (mode === 'create') {
      if (found.reply !== null) return err({ code: 'reviews.already-replied' });
      const reply: ReplyRecord = {
        id: deps.ids.next<'ReviewReply'>(),
        reviewId,
        sellerId: seller.sellerId,
        body: content.value,
        status: 'published',
        createdAt: now,
        editedAt: null,
      };
      if (!(await deps.reviews.insertReplyIfAbsent(context.market, reply))) {
        return err({ code: 'reviews.already-replied' });
      }
      return ok(reviewView({ review: found.review, reply }, settings.replyEditWindowDays));
    }
    if (found.reply === null || found.reply.status !== 'published') {
      return err({ code: 'reviews.not-found' });
    }
    if (!canEditReply(found.reply.createdAt, now, settings.replyEditWindowDays)) {
      return err({ code: 'reviews.edit-window-closed' });
    }
    const edited: ReplyRecord = { ...found.reply, body: content.value, editedAt: now };
    await deps.reviews.saveReply(context.market, edited);
    return ok(reviewView({ review: found.review, reply: edited }, settings.replyEditWindowDays));
  });
}

// ---- report -----------------------------------------------------------------------------------

/**
 * The shop reports a review to the moderators with a reason code. Idempotent per account: a
 * second report of the same review by the same member answers the same. The review stays as it
 * is until a moderator decides; the shop cannot hide it.
 */
export async function reportReview(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly reviewId?: unknown; readonly reasonCode?: unknown },
): Promise<Result<{ readonly reported: true }, ReviewsFailure>> {
  const seller = writingSeller(context);
  if (seller === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const reviewId = parseReviewId(input?.reviewId);
  const reason = validateReportReason(input);
  if (reviewId === null || !reason.ok) {
    return err({
      code: 'validation.failed',
      fields: [
        ...(reviewId === null ? [{ path: 'reviewId', code: 'format' }] : []),
        ...(reason.ok ? [] : reason.error),
      ],
    });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<{ readonly reported: true }, ReviewsFailure>(
    context.market,
    async () => {
      const found = await deps.reviews.findSellerReview(context.market, seller.sellerId, reviewId);
      if (found === null || found.review.status === 'deleted-by-author') {
        return err({ code: 'reviews.not-found' });
      }
      await deps.reviews.insertReportIfAbsent(context.market, {
        id: deps.ids.next<'ReviewReport'>(),
        reviewId,
        reporterAccountId: seller.accountId,
        reasonCode: reason.value,
        createdAt: now,
      });
      return ok({ reported: true } as const);
    },
  );
}
