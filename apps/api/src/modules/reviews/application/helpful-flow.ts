import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { buyerAccountId } from './caller';
import type { ReviewsFailure } from './failures';
import { activeSettings, isStillActive } from './market-switch';
import { PUBLIC_ID } from './read-flow';
import type { ReviewsDependencies } from './reviews-dependencies';

// Helpful votes (package 5): any signed-in buyer may mark a PUBLISHED review "helpful", once per
// review, and take the vote back. Not on their own review, not by a member of the seller's team,
// and at most `maxHelpfulVotesPerAccountPerDay` a day. The answer is the count and whether the
// caller now has a vote; a vote is never shown with its voter. The count itself is kept exact by
// database triggers in the same transaction as the vote.

const DAY_HOURS = 24;

export interface HelpfulVoteInput {
  /** The random public id of the review (the one the public list shows). */
  readonly reviewId?: unknown;
}

export interface HelpfulVoteView {
  readonly reviewId: string;
  readonly helpfulCount: number;
  /** Whether the caller has a vote on the review after this call. */
  readonly voted: boolean;
}

const denied = err({ code: 'access.denied' } as const);

function reviewIdOf(input: HelpfulVoteInput): string | null {
  return typeof input?.reviewId === 'string' && PUBLIC_ID.test(input.reviewId)
    ? input.reviewId
    : null;
}

/** `PUT`: the vote is idempotent (voting twice is one vote and the same answer). */
export async function castHelpfulVote(
  deps: ReviewsDependencies,
  context: CallContext,
  input: HelpfulVoteInput,
): Promise<Result<HelpfulVoteView, ReviewsFailure>> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const publicId = reviewIdOf(input);
  if (publicId === null) return err({ code: 'reviews.not-found' });

  const looked = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.reviews.findPublishedByPublicId(context.market, publicId)),
    { readOnly: true },
  );
  if (!looked.ok) return err({ code: 'reviews.unavailable' });
  const review = looked.value;
  if (review === null) return err({ code: 'reviews.not-found' });
  if (review.accountId === accountId) return err({ code: 'reviews.own-review' });
  // Facade-backed, so asked outside any unit (a failure to answer fails the request closed).
  if (await deps.affinity.isTiedToSeller(context, accountId, review.sellerId)) {
    return err({ code: 'reviews.own-store' });
  }

  const now = deps.clock.now();
  return deps.unitOfWork.run<HelpfulVoteView, ReviewsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'reviews.disabled' } as const);
    const current = await deps.reviews.findPublishedByPublicId(context.market, publicId);
    if (current === null) return err({ code: 'reviews.not-found' } as const);
    const inserted = await deps.reviews.insertHelpfulVote(
      context.market,
      current.id,
      accountId,
      now,
    );
    if (inserted) {
      // The limit counts the vote just cast; over it the unit ends with an error and the vote is
      // rolled back. A vote that already existed is answered as it is, also at the limit.
      const recent = await deps.reviews.countHelpfulVotesSince(
        context.market,
        accountId,
        now.subtract({ hours: DAY_HOURS }),
      );
      if (recent > settings.maxHelpfulVotesPerAccountPerDay) {
        return err({ code: 'reviews.rate-limited' } as const);
      }
    }
    return ok({
      reviewId: publicId,
      helpfulCount: await deps.reviews.readHelpfulCount(context.market, current.id),
      voted: true,
    });
  });
}

/** `DELETE`: takes the caller's vote back; removing a vote that does not exist is the same answer. */
export async function removeHelpfulVote(
  deps: ReviewsDependencies,
  context: CallContext,
  input: HelpfulVoteInput,
): Promise<Result<HelpfulVoteView, ReviewsFailure>> {
  const accountId = buyerAccountId(context);
  if (accountId === null) return denied;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const publicId = reviewIdOf(input);
  if (publicId === null) return err({ code: 'reviews.not-found' });

  return deps.unitOfWork.run<HelpfulVoteView, ReviewsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'reviews.disabled' } as const);
    // A vote can be taken back from a review that is no longer public, but only a published
    // review is looked up by its public id; for any other the vote simply stays (count unseen).
    const review = await deps.reviews.findPublishedByPublicId(context.market, publicId);
    if (review === null) return err({ code: 'reviews.not-found' } as const);
    await deps.reviews.deleteHelpfulVote(context.market, review.id, accountId);
    return ok({
      reviewId: publicId,
      helpfulCount: await deps.reviews.readHelpfulCount(context.market, review.id),
      voted: false,
    });
  });
}
