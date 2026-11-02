import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { ConsumedStepUp } from '../../../platform/authz';
import { ReviewModerated } from '../domain/audit';
import {
  isModeratorAction,
  isQueueTab,
  isReasonFor,
  statusAfter,
  type ModeratorAction,
  type QueueTab,
} from '../domain/moderation';
import type { ReviewStatus } from '../domain/rules';
import { REVIEWS_MODERATE_STEP_UP } from '../contracts/step-up';
import { adminAccountId } from './caller';
import type { FieldIssue } from './failures';
import type {
  HistoryRow,
  ModerationDetailRecord,
  ProductReviewRecord,
  QueueCursor,
  QueueRow,
} from './ports/review.repository';
import type { ReviewsDependencies } from './reviews-dependencies';
import { stepUpFailure } from './settings-flow';

// The admin moderation queue (buyer reviews and ratings package 2; design section 5). A moderator
// reads the held, reported and actioned reviews, and publishes, hides, restores or removes a whole
// review with a closed reason code; dismissing reports changes no status. The text is never
// edited. Moderation works whether the Market switch is on or off: an admin must be able to take
// content down while reviews are off. Every change spends the admin's two-step proof in the unit
// that makes it, is logged in the insert-only moderation log with the moderator's id, and is
// audited with codes only: the review text, title and author are never audited or logged.

export type ModerationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'reviews.not-found' }
  /** The review is not in a status the action applies to, or another request moved it first. */
  | { readonly code: 'reviews.not-moderatable' }
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string };

const invalid = (fields: readonly FieldIssue[]) =>
  err({ code: 'validation.failed', fields } as const);

export const QUEUE_PAGE_SIZE = 25;
export const QUEUE_MAX_PAGE_SIZE = 50;

// ---- views ------------------------------------------------------------------------------------

/** A review as a moderator sees it. No author identity: the moderator judges the content. */
export interface ModerationReviewView {
  readonly id: Id<'ProductReview'>;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly status: ReviewStatus;
  readonly createdAt: Temporal.Instant;
  readonly editedAt: Temporal.Instant | null;
  readonly openReports: number;
  readonly signalCodes: readonly string[];
}

export interface ModerationDetailView extends ModerationReviewView {
  readonly reportReasons: readonly { readonly reasonCode: string; readonly count: number }[];
  readonly history: readonly HistoryRow[];
  /** The actions that apply to the review now (the web shows these and no others). */
  readonly allowedActions: readonly ModeratorAction[];
}

const reviewView = (
  review: ProductReviewRecord,
  openReports: number,
  signalCodes: readonly string[],
): ModerationReviewView => ({
  id: review.id,
  productId: review.productId,
  offerId: review.offerId,
  sellerId: review.sellerId,
  rating: review.rating,
  title: review.title,
  body: review.body,
  locale: review.locale,
  status: review.status,
  createdAt: review.createdAt,
  editedAt: review.editedAt,
  openReports,
  signalCodes,
});

const allowedFor = (detail: ModerationDetailRecord): readonly ModeratorAction[] => {
  const actions: ModeratorAction[] = [];
  for (const action of ['publish', 'hide', 'restore', 'remove'] as const) {
    if (statusAfter(action, detail.review.status) !== null) actions.push(action);
  }
  const reportable = ['published', 'held', 'hidden'].includes(detail.review.status);
  if (reportable && detail.openReports.length > 0) actions.push('dismiss-reports');
  return actions;
};

const detailView = (detail: ModerationDetailRecord): ModerationDetailView => ({
  ...reviewView(
    detail.review,
    detail.openReports.reduce((sum, r) => sum + r.count, 0),
    detail.signalCodes,
  ),
  reportReasons: detail.openReports,
  history: detail.history,
  allowedActions: allowedFor(detail),
});

// ---- cursor -----------------------------------------------------------------------------------

const CURSOR = /^(\d{1,15})_([0-9a-f-]{36})$/;

const encodeCursor = (row: QueueRow): string =>
  `${row.review.createdAt.epochMilliseconds}_${row.review.id}`;

function decodeCursor(raw: string): QueueCursor | null {
  const match = CURSOR.exec(raw);
  if (match === null) return null;
  const id = parseId<'ProductReview'>(match[2]!);
  if (!id.ok) return null;
  return {
    createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    id: id.value,
  };
}

// ---- reads ------------------------------------------------------------------------------------

export interface ListQueueInput {
  readonly tab?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

export interface ModerationQueuePage {
  readonly tab: QueueTab;
  readonly items: readonly ModerationReviewView[];
  readonly nextCursor: string | null;
  readonly counts: Readonly<Record<QueueTab, number>>;
}

export async function listModerationQueue(
  deps: ReviewsDependencies,
  context: CallContext,
  input: ListQueueInput,
): Promise<Result<ModerationQueuePage, ModerationFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const problems: FieldIssue[] = [];
  const tab = input?.tab === undefined ? 'held' : input.tab;
  if (!isQueueTab(tab)) problems.push({ path: 'tab', code: 'value' });
  let after: QueueCursor | null = null;
  if (input?.cursor !== undefined) {
    after = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : null;
    if (after === null) problems.push({ path: 'cursor', code: 'format' });
  }
  let limit = QUEUE_PAGE_SIZE;
  if (input?.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > QUEUE_MAX_PAGE_SIZE
    ) {
      problems.push({ path: 'limit', code: 'range' });
    } else {
      limit = input.limit;
    }
  }
  if (problems.length > 0 || !isQueueTab(tab)) return invalid(problems);
  return deps.unitOfWork.run<ModerationQueuePage, ModerationFailure>(
    context.market,
    async () => {
      const [rows, counts] = await Promise.all([
        deps.reviews.listModerationQueue(context.market, { tab, after, limit: limit + 1 }),
        deps.reviews.countModerationQueue(context.market),
      ]);
      const page = rows.slice(0, limit);
      return ok({
        tab,
        items: page.map((row) => reviewView(row.review, row.openReports, row.signalCodes)),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
        counts,
      });
    },
    { readOnly: true },
  );
}

export async function viewModerationReview(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly reviewId?: unknown },
): Promise<Result<ModerationDetailView, ModerationFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const id = typeof input?.reviewId === 'string' ? parseId<'ProductReview'>(input.reviewId) : null;
  if (id === null || !id.ok) return invalid([{ path: 'reviewId', code: 'format' }]);
  return deps.unitOfWork.run<ModerationDetailView, ModerationFailure>(
    context.market,
    async () => {
      const detail = await deps.reviews.findForModeration(context.market, id.value);
      return detail === null ? err({ code: 'reviews.not-found' } as const) : ok(detailView(detail));
    },
    { readOnly: true },
  );
}

// ---- the change -------------------------------------------------------------------------------

export interface ModerateInput {
  readonly reviewId?: unknown;
  readonly action?: unknown;
  readonly reasonCode?: unknown;
}

/**
 * Applies one moderator action. `allowed` is what the calling use case may do (`remove` is a use
 * case of its own with its own permission); the status rule and the reason list are checked here.
 */
export async function moderateReview(
  deps: ReviewsDependencies,
  context: CallContext,
  input: ModerateInput,
  allowed: readonly ModeratorAction[],
): Promise<Result<ModerationDetailView, ModerationFailure>> {
  const moderatorId = adminAccountId(context);
  if (moderatorId === null) return err({ code: 'access.denied' });
  const problems: FieldIssue[] = [];
  const id = typeof input?.reviewId === 'string' ? parseId<'ProductReview'>(input.reviewId) : null;
  if (id === null || !id.ok) problems.push({ path: 'reviewId', code: 'format' });
  const action = input?.action;
  if (!isModeratorAction(action) || !allowed.includes(action)) {
    problems.push({ path: 'action', code: 'value' });
  } else if (!isReasonFor(action, input?.reasonCode)) {
    problems.push({ path: 'reasonCode', code: 'value' });
  }
  if (problems.length > 0 || id === null || !id.ok || !isModeratorAction(action)) {
    return invalid(problems);
  }
  const reasonCode = input.reasonCode as string;
  const now = deps.clock.now();

  return deps.unitOfWork.run<ModerationDetailView, ModerationFailure>(context.market, async () => {
    const detail = await deps.reviews.findForModeration(context.market, id.value);
    if (detail === null) return err({ code: 'reviews.not-found' } as const);
    const review = detail.review;
    const next = statusAfter(action, review.status);
    if (next === null) return err({ code: 'reviews.not-moderatable' } as const);
    if (action === 'dismiss-reports' && detail.openReports.length === 0) {
      return err({ code: 'reviews.not-moderatable' } as const);
    }

    // The proof is spent after the status check, so a refused action does not use a code up, and
    // before the change, so a missing proof commits nothing.
    let proof: ConsumedStepUp | null = null;
    if (action !== 'dismiss-reports') {
      const spent = await deps.stepUp.consume(context, REVIEWS_MODERATE_STEP_UP);
      if (!spent.ok) return err(stepUpFailure(spent.error));
      proof = spent.value;
    }

    if (action === 'dismiss-reports') {
      await deps.reviews.closeOpenReports(context.market, review.id, 'dismissed');
    } else {
      const changed: ProductReviewRecord = {
        ...review,
        status: next,
        publishedAt:
          next === 'published'
            ? action === 'publish'
              ? now
              : (review.publishedAt ?? now)
            : review.publishedAt,
      };
      if (
        (await deps.reviews.saveProductReview(context.market, changed, review.status)) === 'stale'
      ) {
        return err({ code: 'reviews.not-moderatable' } as const);
      }
      await deps.reviews.appendModerationAction(context.market, {
        id: deps.ids.next<'ModerationAction'>(),
        reviewId: review.id,
        actorAccountId: moderatorId,
        action,
        reasonCode,
        fromStatus: review.status,
        toStatus: next,
        at: now,
      });
      if (action === 'hide' || action === 'remove') {
        await deps.reviews.closeOpenReports(context.market, review.id, 'actioned');
      }
      await deps.reviews.rebuildSummaries(
        context.market,
        { products: [review.productId], sellers: [] },
        now,
      );
    }

    await deps.audit.record(
      context,
      ReviewModerated.entry(review.id, {
        before: { status: review.status },
        after: {
          status: next,
          action,
          reasonCode,
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    const after = await deps.reviews.findForModeration(context.market, review.id);
    return after === null ? err({ code: 'reviews.not-found' } as const) : ok(detailView(after));
  });
}
