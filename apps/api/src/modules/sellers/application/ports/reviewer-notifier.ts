import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * What `identity` did with a request to tell the reviewers of a waiting application (identity
 * design 8.7; sellers design 7.5). `sent` is the only answer after which the caller keeps its
 * coalescing reservation; `skipped` means nothing was sent and nothing will be (the seller is
 * unknown or no longer pending, or no admin may approve); `unavailable` means nothing was sent
 * and a retry is right.
 */
export type ReviewerNoticeResult = 'sent' | 'skipped' | 'unavailable';

/**
 * Asks `identity` to notify the admins who may approve (system actor only). Called outside any
 * unit of work. The adapter throws on a refusal of the gate or a malformed answer, which the
 * caller treats like `unavailable`.
 */
export interface ReviewerNotifier {
  notify(context: CallContext, sellerId: Id<'Seller'>): Promise<ReviewerNoticeResult>;
}

export const REVIEWER_NOTIFIER = Symbol('REVIEWER_NOTIFIER');
