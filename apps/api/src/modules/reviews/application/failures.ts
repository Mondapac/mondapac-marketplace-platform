/** A field the request got wrong: a path and a code, never the value. */
export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

/**
 * Every refusal a reviews use case answers (besides the gate's own). The code is the whole
 * message: no text of a review ever travels in a failure.
 */
export type ReviewsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  /** Reviews are off in this Market. */
  | { readonly code: 'reviews.disabled' }
  /** The Market has no review settings, or a service reviews depends on did not answer. */
  | { readonly code: 'reviews.unavailable' }
  /** The account has no delivered seller order with this product (or this seller order). */
  | { readonly code: 'reviews.not-eligible' }
  /** The delivery is older than the review window of the Market. */
  | { readonly code: 'reviews.window-closed' }
  | { readonly code: 'reviews.already-reviewed' }
  | { readonly code: 'reviews.already-rated' }
  /** Unknown and someone else's review are one answer. */
  | { readonly code: 'reviews.not-found' }
  /** Only a published or held review of the author can change; a hidden or removed one cannot. */
  | { readonly code: 'reviews.not-editable' }
  | { readonly code: 'reviews.edit-window-closed' }
  | { readonly code: 'reviews.rate-limited' }
  /** The review already has the shop's one public reply. */
  | { readonly code: 'reviews.already-replied' }
  /** The account is tied to the seller (a member of its team): nobody reviews their own shop. */
  | { readonly code: 'reviews.own-store' };

/** What the summary reads can refuse (these match the public facade's failure codes). */
export type SummaryFailure = Extract<
  ReviewsFailure,
  { readonly code: 'validation.failed' | 'reviews.disabled' | 'reviews.unavailable' }
>;

export type ReviewsFailureCode = ReviewsFailure['code'];
