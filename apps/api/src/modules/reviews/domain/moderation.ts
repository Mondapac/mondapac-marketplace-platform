import type { ReviewStatus } from './rules';

// The pure rules of the moderator queue (buyer reviews and ratings package 2; design section 5).
// A moderator moves a whole review between statuses with a reason code; the text is never edited.
// There is deliberately no reason code for "negative" or "the seller asked": a true negative review
// inside the policy is never hidden for being negative (ACCC guidance, owner decision N5).

/** What a moderator can do to a review. `dismiss-reports` changes no status. */
export const MODERATOR_ACTIONS = [
  'publish',
  'hide',
  'restore',
  'remove',
  'dismiss-reports',
] as const;
export type ModeratorAction = (typeof MODERATOR_ACTIONS)[number];

/** Reasons for hiding a review (reversible). */
export const HIDE_REASON_CODES = [
  'personal-information',
  'abusive',
  'irrelevant',
  'not-a-purchase',
  'incentivised',
  'spam',
  'other',
] as const;

/** Reasons for removing a review (not reversible): illegal, defamatory or private content. */
export const REMOVE_REASON_CODES = [
  'illegal',
  'defamatory',
  'personal-information',
  'abusive',
] as const;

/** Reasons for publishing a held review or restoring a hidden one. */
export const PUBLISH_REASON_CODES = ['checked-ok'] as const;
export const RESTORE_REASON_CODES = ['reinstated', 'hidden-in-error'] as const;

/** Reasons for dismissing the open reports of a review. */
export const DISMISS_REASON_CODES = ['not-against-policy', 'duplicate'] as const;

export const REASONS_BY_ACTION: Readonly<Record<ModeratorAction, readonly string[]>> = {
  publish: PUBLISH_REASON_CODES,
  hide: HIDE_REASON_CODES,
  restore: RESTORE_REASON_CODES,
  remove: REMOVE_REASON_CODES,
  'dismiss-reports': DISMISS_REASON_CODES,
};

/** The status a review moves to by an action from a status, or null when it is not allowed. */
export function statusAfter(action: ModeratorAction, from: ReviewStatus): ReviewStatus | null {
  switch (action) {
    case 'publish':
      return from === 'held' ? 'published' : null;
    case 'hide':
      return from === 'published' || from === 'held' ? 'hidden' : null;
    case 'restore':
      return from === 'hidden' ? 'published' : null;
    case 'remove':
      return from === 'published' || from === 'held' || from === 'hidden' ? 'removed' : null;
    case 'dismiss-reports':
      return from === 'deleted-by-author' ? null : from;
  }
}

export const isModeratorAction = (value: unknown): value is ModeratorAction =>
  typeof value === 'string' && (MODERATOR_ACTIONS as readonly string[]).includes(value);

export const isReasonFor = (action: ModeratorAction, value: unknown): value is string =>
  typeof value === 'string' && REASONS_BY_ACTION[action].includes(value);

/**
 * The tabs of the queue: `held` (waiting after an automatic check), `reported` (an open report) and
 * `actioned` (hidden or removed). A `flagged` tab for abuse signals on published reviews comes with
 * the signals of package 5.
 */
export const QUEUE_TABS = ['held', 'reported', 'actioned'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
export const isQueueTab = (value: unknown): value is QueueTab =>
  typeof value === 'string' && (QUEUE_TABS as readonly string[]).includes(value);
