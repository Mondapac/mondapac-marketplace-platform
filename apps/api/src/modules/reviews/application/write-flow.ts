import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { evaluateEligibility } from '../domain/eligibility';
import {
  isEditableStatus,
  isWithinEditWindow,
  isWithinReviewWindow,
  validateProductReviewInput,
  validateSellerRatingInput,
  type FieldProblem,
  type ProductReviewContent,
  type ReviewStatus,
} from '../domain/rules';
import { checkText } from '../domain/text-checks';
import { buyerAccountId } from './caller';
import { activeSettings, isStillActive } from './market-switch';
import type {
  NewModerationAction,
  NewSignal,
  ProductReviewRecord,
  SellerRatingRecord,
} from './ports/review.repository';
import type { ReviewsSettings } from './ports/reviews-policy';
import { deliveredPurchases, lookbackSince } from './purchases';
import type { ReviewsFailure } from './failures';
import type { ReviewsDependencies } from './reviews-dependencies';
import {
  ownReviewView,
  ownSellerRatingView,
  type OwnReviewView,
  type OwnSellerRatingView,
} from './views';

// The buyer's writes (owner decisions N1, N2, N4, N5): submit a product review, edit it, delete it,
// and rate a seller order. Order of work in every use case: the caller and the input first, the
// switch, then eligibility asked of ordering and catalog (facade calls, never inside a unit), then
// ONE read-write unit that re-checks the switch, applies the daily limit and writes. The text of a
// review is never logged, audited, evented or put in a signal or a failure.

const DAY_HOURS = 24;

const denied = err({ code: 'access.denied' } as const);

const invalid = (fields: readonly FieldProblem[]) =>
  err({ code: 'validation.failed', fields } as const);

/** The status a text earns: a clean text publishes at once, any signal holds it for a human. */
export const statusForSignals = (signals: readonly string[]): ReviewStatus =>
  signals.length === 0 ? 'published' : 'held';

function signalsOf(
  deps: ReviewsDependencies,
  subject: NewSignal['subject'],
  subjectId: NewSignal['subjectId'],
  codes: readonly string[],
  at: Temporal.Instant,
): NewSignal[] {
  return codes.map((code) => ({
    id: deps.ids.next<'ReviewSignal'>(),
    subject,
    subjectId,
    code,
    at,
  }));
}

function logStatus(
  deps: ReviewsDependencies,
  review: Pick<ProductReviewRecord, 'id'>,
  actor: Id<'Account'> | null,
  action: NewModerationAction['action'],
  reasonCode: string,
  from: ReviewStatus | null,
  to: ReviewStatus,
  at: Temporal.Instant,
): NewModerationAction {
  return {
    id: deps.ids.next<'ModerationAction'>(),
    reviewId: review.id,
    actorAccountId: actor,
    action,
    reasonCode,
    fromStatus: from,
    toStatus: to,
    at,
  };
}

function resolveLocale(
  settings: ReviewsSettings,
  locale: unknown,
): { ok: true; value: string } | { ok: false; issue: FieldProblem } {
  if (locale === undefined || locale === null) return { ok: true, value: settings.defaultLocale };
  if (typeof locale !== 'string' || !settings.supportedLocales.includes(locale)) {
    return { ok: false, issue: { path: 'locale', code: 'value' } };
  }
  return { ok: true, value: locale };
}

// ---- submit -----------------------------------------------------------------------------------

export interface SubmitReviewInput {
  readonly productId?: unknown;
  readonly rating?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly anonymous?: unknown;
  readonly locale?: unknown;
}

export interface SubmittedReview {
  /**
   * `created`: a new review; `resubmitted`: the author had deleted theirs and wrote a new one;
   * `purchase-recorded`: the product was already reviewed and this later purchase only moved the
   * "Bought from" label and date (the content of the request is not used; edit with PATCH).
   */
  readonly outcome: 'created' | 'resubmitted' | 'purchase-recorded';
  readonly review: OwnReviewView;
}

export async function submitProductReview(
  deps: ReviewsDependencies,
  context: CallContext,
  input: SubmitReviewInput,
): Promise<Result<SubmittedReview, ReviewsFailure>> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;

  const problems: FieldProblem[] = [];
  const productId =
    typeof input?.productId === 'string' ? parseId<'Product'>(input.productId) : null;
  if (productId === null || !productId.ok) problems.push({ path: 'productId', code: 'format' });
  const content = validateProductReviewInput(input, settings);
  if (!content.ok) problems.push(...content.error);
  const locale = resolveLocale(settings, input?.locale);
  if (!locale.ok) problems.push(locale.issue);
  if (problems.length > 0 || productId === null || !productId.ok || !content.ok || !locale.ok) {
    return invalid(problems);
  }

  // Eligibility: asked of ordering (delivered seller orders) and catalog (offer to product).
  const now = deps.clock.now();
  const purchases = await deliveredPurchases(
    deps,
    context,
    { since: lookbackSince(now, settings) },
    true,
  );
  if (!purchases.ok) return purchases;
  const eligibility = evaluateEligibility(
    purchases.value.candidates,
    productId.value,
    now,
    settings.reviewWindowDays,
  );
  if (eligibility.kind === 'not-eligible') return err({ code: 'reviews.not-eligible' });
  if (eligibility.kind === 'window-closed') return err({ code: 'reviews.window-closed' });
  const purchase = eligibility.purchase;

  if (await deps.affinity.isTiedToSeller(context, accountId, purchase.sellerId)) {
    return err({ code: 'reviews.own-store' });
  }

  const signals = checkText(content.value, settings.textRules);
  const status = statusForSignals(signals);

  return deps.unitOfWork.run<SubmittedReview, ReviewsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'reviews.disabled' } as const);
    const since = now.subtract({ hours: DAY_HOURS });
    const recent = await deps.reviews.countSubmissionsSince(context.market, accountId, since);
    if (recent >= settings.maxSubmissionsPerAccountPerDay) {
      return err({ code: 'reviews.rate-limited' } as const);
    }

    const fresh: ProductReviewRecord = {
      id: deps.ids.next<'ProductReview'>(),
      accountId,
      productId: productId.value,
      offerId: purchase.offerId,
      sellerId: purchase.sellerId,
      lastSellerOrderId: purchase.sellerOrderId,
      rating: content.value.rating,
      title: content.value.title,
      body: content.value.body,
      locale: locale.value,
      anonymous: content.value.anonymous,
      status,
      createdAt: now,
      editedAt: null,
      publishedAt: status === 'published' ? now : null,
      deletedAt: null,
      lastPurchaseAt: purchase.deliveredAt,
    };

    // The common path: no review yet. Two concurrent submits both reach the insert; the unique
    // key lets one win and the other fall through to the existing-row path below.
    const existing0 = await deps.reviews.findOwnProductReview(
      context.market,
      accountId,
      productId.value,
    );
    if (existing0 === null) {
      if (await deps.reviews.insertProductReviewIfAbsent(context.market, fresh)) {
        await afterWrite(deps, context, fresh, null, signals, 'submitted', 'publish', now);
        return ok({ outcome: 'created', review: ownReviewView(fresh, settings.editWindowDays) });
      }
    }
    const existing =
      existing0 ??
      (await deps.reviews.findOwnProductReview(context.market, accountId, productId.value));
    if (existing === null) return err({ code: 'reviews.already-reviewed' } as const);

    if (existing.status === 'deleted-by-author') {
      // The author deleted their review and writes a new one: the row starts over.
      const revived: ProductReviewRecord = { ...fresh, id: existing.id };
      if (
        (await deps.reviews.saveProductReview(context.market, revived, 'deleted-by-author')) ===
        'stale'
      ) {
        return err({ code: 'reviews.already-reviewed' } as const);
      }
      await afterWrite(
        deps,
        context,
        revived,
        'deleted-by-author',
        signals,
        'submitted',
        'publish',
        now,
      );
      return ok({
        outcome: 'resubmitted',
        review: ownReviewView(revived, settings.editWindowDays),
      });
    }

    // A review exists. A later purchase of the product moves its "Bought from" label and date.
    if (purchase.deliveredAt.epochMilliseconds > existing.lastPurchaseAt.epochMilliseconds) {
      const moved: ProductReviewRecord = {
        ...existing,
        offerId: purchase.offerId,
        sellerId: purchase.sellerId,
        lastSellerOrderId: purchase.sellerOrderId,
        lastPurchaseAt: purchase.deliveredAt,
      };
      if (
        (await deps.reviews.saveProductReview(context.market, moved, existing.status)) === 'saved'
      ) {
        return ok({
          outcome: 'purchase-recorded',
          review: ownReviewView(moved, settings.editWindowDays),
        });
      }
    }
    return err({ code: 'reviews.already-reviewed' } as const);
  });
}

/** The log row, the signals and the summary refresh that follow a new or restarted review. */
async function afterWrite(
  deps: ReviewsDependencies,
  context: CallContext,
  review: ProductReviewRecord,
  from: ReviewStatus | null,
  signals: readonly string[],
  reasonCode: string,
  publishAction: NewModerationAction['action'],
  now: Temporal.Instant,
): Promise<void> {
  await deps.reviews.appendModerationAction(
    context.market,
    logStatus(
      deps,
      review,
      review.accountId,
      review.status === 'held' ? 'auto-hold' : publishAction,
      review.status === 'held' ? 'auto-check' : reasonCode,
      from,
      review.status,
      now,
    ),
  );
  if (signals.length > 0) {
    await deps.reviews.appendSignals(
      context.market,
      signalsOf(deps, 'product-review', review.id, signals, now),
    );
  }
  await deps.reviews.rebuildSummaries(
    context.market,
    { products: [review.productId], sellers: [] },
    now,
  );
}

// ---- edit -------------------------------------------------------------------------------------

export interface EditReviewInput {
  readonly reviewId?: unknown;
  readonly rating?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly anonymous?: unknown;
}

export async function editProductReview(
  deps: ReviewsDependencies,
  context: CallContext,
  input: EditReviewInput,
): Promise<Result<OwnReviewView, ReviewsFailure>> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;

  const reviewId =
    typeof input?.reviewId === 'string' ? parseId<'ProductReview'>(input.reviewId) : null;
  if (reviewId === null || !reviewId.ok) return err({ code: 'reviews.not-found' });
  const changed = ['rating', 'title', 'body', 'anonymous'].filter(
    (key) => (input as Record<string, unknown>)[key] !== undefined,
  );
  if (changed.length === 0) return invalid([{ path: '', code: 'empty' }]);

  const now = deps.clock.now();
  return deps.unitOfWork.run<OwnReviewView, ReviewsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'reviews.disabled' } as const);
    const existing = await deps.reviews.findOwnProductReviewById(
      context.market,
      accountId,
      reviewId.value,
    );
    if (existing === null || existing.status === 'deleted-by-author') {
      return err({ code: 'reviews.not-found' } as const);
    }
    if (!isEditableStatus(existing.status)) return err({ code: 'reviews.not-editable' } as const);
    if (!isWithinEditWindow(existing.createdAt, now, settings.editWindowDays)) {
      return err({ code: 'reviews.edit-window-closed' } as const);
    }

    // The request overlays the stored content; null clears a title or a body.
    const merged: Record<string, unknown> = {
      rating: existing.rating,
      title: existing.title,
      body: existing.body,
      anonymous: existing.anonymous,
    };
    for (const key of changed) merged[key] = (input as Record<string, unknown>)[key];
    const content = validateProductReviewInput(merged, settings);
    if (!content.ok) return invalid(content.error);

    const signals = checkText(content.value, settings.textRules);
    // A clean edit leaves a held review held (a human releases it); a flagged edit holds it.
    const status: ReviewStatus =
      signals.length > 0 ? 'held' : existing.status === 'held' ? 'held' : 'published';
    const edited: ProductReviewRecord = {
      ...existing,
      ...contentColumns(content.value),
      status,
      editedAt: now,
      publishedAt: existing.publishedAt ?? (status === 'published' ? now : null),
    };
    if (
      (await deps.reviews.saveProductReview(context.market, edited, existing.status)) === 'stale'
    ) {
      return err({ code: 'reviews.not-editable' } as const);
    }
    await deps.reviews.appendModerationAction(
      context.market,
      logStatus(deps, edited, accountId, 'author-edit', 'author', existing.status, status, now),
    );
    if (signals.length > 0) {
      await deps.reviews.appendSignals(
        context.market,
        signalsOf(deps, 'product-review', edited.id, signals, now),
      );
    }
    await deps.reviews.rebuildSummaries(
      context.market,
      { products: [edited.productId], sellers: [] },
      now,
    );
    return ok(ownReviewView(edited, settings.editWindowDays));
  });
}

const contentColumns = (content: ProductReviewContent) => ({
  rating: content.rating,
  title: content.title,
  body: content.body,
  anonymous: content.anonymous,
});

// ---- delete -----------------------------------------------------------------------------------

export async function deleteProductReview(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly reviewId?: unknown },
): Promise<
  Result<{ readonly id: Id<'ProductReview'>; readonly status: 'deleted-by-author' }, ReviewsFailure>
> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;

  const reviewId =
    typeof input?.reviewId === 'string' ? parseId<'ProductReview'>(input.reviewId) : null;
  if (reviewId === null || !reviewId.ok) return err({ code: 'reviews.not-found' });

  const now = deps.clock.now();
  return deps.unitOfWork.run<
    { readonly id: Id<'ProductReview'>; readonly status: 'deleted-by-author' },
    ReviewsFailure
  >(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'reviews.disabled' } as const);
    const existing = await deps.reviews.findOwnProductReviewById(
      context.market,
      accountId,
      reviewId.value,
    );
    if (existing === null) return err({ code: 'reviews.not-found' } as const);
    // Deleting twice is the same answer; a review a moderator hid or removed stays as it is.
    if (existing.status === 'deleted-by-author') {
      return ok({ id: existing.id, status: 'deleted-by-author' } as const);
    }
    if (!isEditableStatus(existing.status)) return err({ code: 'reviews.not-editable' } as const);
    const deleted: ProductReviewRecord = {
      ...existing,
      title: null,
      body: null,
      status: 'deleted-by-author',
      deletedAt: now,
    };
    if (
      (await deps.reviews.saveProductReview(context.market, deleted, existing.status)) === 'stale'
    ) {
      return err({ code: 'reviews.not-editable' } as const);
    }
    await deps.reviews.appendModerationAction(
      context.market,
      logStatus(
        deps,
        deleted,
        accountId,
        'author-delete',
        'author',
        existing.status,
        'deleted-by-author',
        now,
      ),
    );
    await deps.reviews.rebuildSummaries(
      context.market,
      { products: [deleted.productId], sellers: [] },
      now,
    );
    return ok({ id: deleted.id, status: 'deleted-by-author' } as const);
  });
}

// ---- rate a seller order ----------------------------------------------------------------------

export interface RateSellerOrderInput {
  readonly sellerOrderId?: unknown;
  readonly satisfaction?: unknown;
  readonly asDescribed?: unknown;
  readonly arrivedOk?: unknown;
  readonly reasonCode?: unknown;
}

export async function rateSellerOrder(
  deps: ReviewsDependencies,
  context: CallContext,
  input: RateSellerOrderInput,
): Promise<Result<OwnSellerRatingView, ReviewsFailure>> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;

  const sellerOrderId =
    typeof input?.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
  if (sellerOrderId === null || !sellerOrderId.ok) {
    return invalid([{ path: 'sellerOrderId', code: 'format' }]);
  }
  const content = validateSellerRatingInput(input);
  if (!content.ok) return invalid(content.error);

  const now = deps.clock.now();
  const purchases = await deliveredPurchases(
    deps,
    context,
    { since: lookbackSince(now, settings), sellerOrderId: sellerOrderId.value },
    false,
  );
  if (!purchases.ok) return purchases;
  const order = purchases.value.orders.find((o) => o.sellerOrderId === sellerOrderId.value);
  if (order === undefined) return err({ code: 'reviews.not-eligible' });
  if (!isWithinReviewWindow(order.deliveredAt, now, settings.reviewWindowDays)) {
    return err({ code: 'reviews.window-closed' });
  }
  if (await deps.affinity.isTiedToSeller(context, accountId, order.sellerId)) {
    return err({ code: 'reviews.own-store' });
  }

  return deps.unitOfWork.run<OwnSellerRatingView, ReviewsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'reviews.disabled' } as const);
    const recent = await deps.reviews.countSubmissionsSince(
      context.market,
      accountId,
      now.subtract({ hours: DAY_HOURS }),
    );
    if (recent >= settings.maxSubmissionsPerAccountPerDay) {
      return err({ code: 'reviews.rate-limited' } as const);
    }
    const record: SellerRatingRecord = {
      id: deps.ids.next<'SellerRating'>(),
      accountId,
      sellerOrderId: order.sellerOrderId,
      sellerId: order.sellerId,
      satisfaction: content.value.satisfaction,
      asDescribed: content.value.asDescribed,
      arrivedOk: content.value.arrivedOk,
      reasonCode: content.value.reasonCode,
      status: 'published',
      createdAt: now,
    };
    if (!(await deps.reviews.insertSellerRatingIfAbsent(context.market, record))) {
      return err({ code: 'reviews.already-rated' } as const);
    }
    await deps.reviews.rebuildSummaries(
      context.market,
      { products: [], sellers: [record.sellerId] },
      now,
    );
    return ok(ownSellerRatingView(record));
  });
}
