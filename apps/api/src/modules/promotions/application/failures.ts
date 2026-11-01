import type { FieldIssue } from '../domain/promotion';

export type { FieldIssue };

/**
 * Every refusal a promotions use case answers (besides the gate's own). The code is the whole
 * message: no promotion name or code travels in a failure.
 */
export type PromotionsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  /** Promotions are off in this Market (the default until an admin switches them on). */
  | { readonly code: 'promotions.disabled' }
  /** The Market has no promotions settings, or a read failed: callers fail closed. */
  | { readonly code: 'promotions.unavailable' }
  /** Unknown and someone else's promotion are one answer. */
  | { readonly code: 'promotions.not-found' }
  | { readonly code: 'promotions.code-taken' }
  /** The promotion's state does not allow this (pause of a paused one is idempotent, not this). */
  | { readonly code: 'promotions.invalid-state' }
  /** The seller already has the Market's maximum of active and pending promotions. */
  | { readonly code: 'promotions.too-many-active' }
  /** Not editable by this caller: an admin on a seller's promotion, a rejected promotion. */
  | { readonly code: 'promotions.not-editable' }
  /**
   * The customer cannot be referred: they are the referrer, have ordered before, were referred
   * already, or the facts to tell could not be read. One answer for all of them.
   */
  | { readonly code: 'promotions.referral-not-eligible' }
  /** The step-up refusals of identity, as the use case passes them on. */
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'access.unavailable' };

/** The refusals of the reads that need no input beyond the Market. */
export type ReadFailure = Extract<
  PromotionsFailure,
  { readonly code: 'access.denied' | 'promotions.disabled' | 'promotions.unavailable' }
>;
