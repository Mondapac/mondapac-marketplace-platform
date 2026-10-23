import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * What the caller must pass besides its `CallContext` to read a subject's recent views: the
 * browser's privacy signals and, for a guest, the raw engagement guest cookie token. The subject
 * itself is the context's customer account or that token, never a request field.
 */
export interface RecentViewsRequest {
  /** `Sec-GPC: 1` on the request: the answer is empty. */
  readonly globalPrivacyControl: boolean;
  /** `Engagement-Consent: granted` on the request (guests only; a customer's switch applies). */
  readonly consent: boolean;
  /** The raw engagement guest cookie token (guests only); null when there is none. */
  readonly guestToken: string | null;
}

/** A subject's recently viewed ids: distinct, newest first, at most 50 of each. Ids only. */
export interface RecentViews {
  readonly productIds: readonly Id<'Product'>[];
  readonly categoryIds: readonly Id<'Category'>[];
}

/**
 * What other modules may ask `engagement` (personalization package 1a). Behaviour stays in
 * `engagement`; the recommendations of package 1d read it through the methods here.
 */
export interface EngagementFacade {
  /**
   * Deletes everything engagement holds about an account in the Market (its behaviour and its
   * personalization switch), for account deletion. Rule `system`. Safe to call twice.
   */
  forgetAccount(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly events: number }, AccessDenied>>;

  /**
   * The recently viewed product and category ids of the subject of the call: the signed-in
   * customer, or the guest named by `request.guestToken`, in the call's Market only. Distinct,
   * newest first, at most 50 of each; ids only. Empty, and nothing read, with `Sec-GPC: 1`, with
   * the customer's personalization switch off, and for a guest without consent or a well-formed
   * token. Reads only: never records, never sets, extends or clears a cookie. Two use cases
   * behind this method (`own-resources` for a customer, `anonymous` for a guest), chosen by the
   * call's actor. An unreadable store rejects the call: the consumer fails closed.
   */
  recentViews(
    context: CallContext,
    request: RecentViewsRequest,
  ): Promise<Result<RecentViews, AccessDenied>>;
}

export const ENGAGEMENT_FACADE = Symbol('ENGAGEMENT_FACADE');
