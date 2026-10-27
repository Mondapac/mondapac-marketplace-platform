// The runtime switch of reviews in one Market: `off` (the default; no row means off) or `active`.
// It decides whether the module reads or writes at all; turning it off deletes nothing.

export const REVIEWS_STATUSES = ['off', 'active'] as const;
export type ReviewsStatus = (typeof REVIEWS_STATUSES)[number];

export const isReviewsStatus = (value: unknown): value is ReviewsStatus =>
  typeof value === 'string' && (REVIEWS_STATUSES as readonly string[]).includes(value);
