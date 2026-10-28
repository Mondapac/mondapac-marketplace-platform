import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { auditCode, CoFundingOptInChanged, PromotionReviewDecided } from '../domain/audit';
import { adminAccountId, sellerCaller } from './caller';
import type { PromotionsFailure } from './failures';
import { activeSettings, isStillActive } from './market-switch';
import type { ReviewEntry } from './ports/review-queue.repository';
import type { PromotionsDependencies } from './promotions-dependencies';
import { promotionViewOf, type PromotionView } from './views';

// The admin review queue of seller promotions and the seller's opt-in to co-funded campaigns.

export interface ReviewItem {
  readonly review: ReviewEntry;
  readonly promotion: PromotionView;
}

const MAX_QUEUE = 200;

export async function listReviews(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<readonly ReviewItem[], PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  return deps.unitOfWork.run<readonly ReviewItem[], PromotionsFailure>(
    context.market,
    async () => {
      const open = await deps.reviews.listOpen(context.market, MAX_QUEUE);
      const ids = [...new Set(open.map((entry) => entry.promotionId))];
      const records = await deps.promotions.findMany(context.market, ids);
      const usage = await deps.promotions.usageOf(context.market, ids);
      const byId = new Map(records.map((record) => [record.id, record]));
      const items: ReviewItem[] = [];
      for (const review of open) {
        const record = byId.get(review.promotionId);
        if (record !== undefined) {
          items.push({ review, promotion: promotionViewOf(record, usage.get(record.id)) });
        }
      }
      return ok(items);
    },
    { readOnly: true },
  );
}

/** The promotion version the admin looked at: the instant the promotion was last changed. */
function versionOf(raw: unknown): Temporal.Instant | null {
  if (typeof raw !== 'string') return null;
  try {
    return Temporal.Instant.from(raw);
  } catch {
    return null;
  }
}

/**
 * An admin decides an entry of the queue on the promotion as the admin saw it: `promotionVersion`
 * is the promotion's `updatedAt` from the queue, and a promotion changed since (a seller edit, a
 * pause) is `promotions.invalid-state` (409), so a decision is never made on terms the admin did
 * not read. Approving a promotion that waits for approval puts it
 * live; approving a live one records that it was reviewed (and lifts the cautious limit on a
 * fixed reward). Rejecting stops the promotion for good (REJECTED); the seller may start another.
 */
export async function decideReview(
  deps: PromotionsDependencies,
  context: CallContext,
  input: {
    readonly reviewId?: unknown;
    readonly decision?: unknown;
    readonly promotionVersion?: unknown;
  },
): Promise<Result<ReviewItem, PromotionsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const reviewId =
    typeof input?.reviewId === 'string' ? parseId<'PromotionReview'>(input.reviewId) : null;
  const fields: { path: string; code: string }[] = [];
  if (reviewId === null || !reviewId.ok) fields.push({ path: 'reviewId', code: 'value' });
  const decision = input?.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT')
    fields.push({ path: 'decision', code: 'value' });
  const version = versionOf(input?.promotionVersion);
  if (version === null) fields.push({ path: 'promotionVersion', code: 'value' });
  if (fields.length > 0 || reviewId === null || !reviewId.ok || version === null) {
    return err({ code: 'validation.failed', fields });
  }
  const now = deps.clock.now();

  return deps.unitOfWork.run<ReviewItem, PromotionsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const entry = await deps.reviews.find(context.market, reviewId.value);
    if (entry === null) return err({ code: 'promotions.not-found' });
    if (entry.status !== 'OPEN') return err({ code: 'promotions.invalid-state' });
    const before = await deps.promotions.findForUpdate(context.market, entry.promotionId);
    if (before === null) return err({ code: 'promotions.not-found' });
    // The promotion changed since the admin looked at it: nothing is decided.
    if (!before.updatedAt.equals(version)) return err({ code: 'promotions.invalid-state' });
    const approve = decision === 'APPROVE';
    const after = approve
      ? {
          ...before,
          status: before.status === 'PENDING_APPROVAL' ? ('ACTIVE' as const) : before.status,
          priorApproved: true,
          updatedAt: now,
        }
      : {
          ...before,
          status: 'REJECTED' as const,
          pausedBy: null,
          priorApproved: false,
          updatedAt: now,
        };
    await deps.reviews.decide(
      context.market,
      entry.id,
      approve ? 'APPROVED' : 'REJECTED',
      now,
      adminId,
    );
    await deps.promotions.update(context.market, after);
    await deps.audit.record(
      context,
      PromotionReviewDecided.entry(entry.id, {
        before: { promotionStatus: auditCode(before.status) },
        after: {
          decision: approve ? 'approved' : 'rejected',
          promotionStatus: auditCode(after.status),
          promotionId: before.id,
        },
      }),
    );
    const decided: ReviewEntry = {
      ...entry,
      status: approve ? 'APPROVED' : 'REJECTED',
      decidedAt: now,
    };
    return ok({ review: decided, promotion: promotionViewOf(after, undefined) });
  });
}

/** A seller opts in to (or withdraws from) a co-funded campaign, for its own products only. */
export async function setOptIn(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown; readonly optIn?: unknown },
): Promise<
  Result<{ readonly promotionId: Id<'Promotion'>; readonly optedIn: boolean }, PromotionsFailure>
> {
  const seller = sellerCaller(context);
  if (seller === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const parsed =
    typeof input?.promotionId === 'string' ? parseId<'Promotion'>(input.promotionId) : null;
  const fields: { path: string; code: string }[] = [];
  if (parsed === null || !parsed.ok) fields.push({ path: 'promotionId', code: 'value' });
  if (typeof input?.optIn !== 'boolean') fields.push({ path: 'optIn', code: 'value' });
  if (fields.length > 0 || parsed === null || !parsed.ok) {
    return err({ code: 'validation.failed', fields });
  }
  const optIn = input.optIn === true;
  const now = deps.clock.now();

  return deps.unitOfWork.run<
    { readonly promotionId: Id<'Promotion'>; readonly optedIn: boolean },
    PromotionsFailure
  >(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const promotion = await deps.promotions.findForUpdate(context.market, parsed.value);
    // A campaign the admin aimed at other sellers does not exist for this one.
    if (
      promotion === null ||
      promotion.type !== 'CO_FUNDED_CAMPAIGN' ||
      (promotion.sellerIds.length > 0 && !promotion.sellerIds.includes(seller.sellerId))
    ) {
      return err({ code: 'promotions.not-found' });
    }
    if (promotion.status !== 'ACTIVE' && promotion.status !== 'PAUSED') {
      return err({ code: 'promotions.invalid-state' });
    }
    const existing = await deps.optIns.find(context.market, promotion.id, seller.sellerId);
    const was = existing !== null && existing.withdrawnAt === null;
    if (was === optIn) return ok({ promotionId: promotion.id, optedIn: optIn });
    if (optIn) {
      await deps.optIns.optIn(context.market, promotion.id, seller.sellerId, now, seller.accountId);
    } else {
      await deps.optIns.withdraw(
        context.market,
        promotion.id,
        seller.sellerId,
        now,
        seller.accountId,
      );
    }
    await deps.audit.record(
      context,
      CoFundingOptInChanged.entry(promotion.id, {
        before: { optedIn: was },
        after: { optedIn: optIn, sellerId: seller.sellerId },
      }),
    );
    return ok({ promotionId: promotion.id, optedIn: optIn });
  });
}
