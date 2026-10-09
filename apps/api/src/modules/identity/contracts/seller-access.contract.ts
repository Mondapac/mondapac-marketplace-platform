import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

// The seller-access contract of `identity`, for `sellers` only (ADR-0022 decision 6; Ali, G2).
// It is deliberately NOT exported by ../index.ts: the dependency-cruiser rule
// `seller-access-contract-is-for-sellers` lets only modules/sellers/ import this file, so no
// other module can read a seller's access state, which would bypass the may-sell contract that
// `sellers` owns (`sellingEligibility`). The module-public-api-only rule names this file as the
// one entry besides index.ts.

/** The access states of a seller (identity design 3.3); the codes never change. */
export type SellerAccessState = 'pending' | 'approved' | 'rejected' | 'suspended';

/**
 * One answer of `sellerAccessOf` (identity design 8.1, 8.3): the state and the instant of its
 * latest change. Never a reason. An id absent from the answer is unknown: "may not sell".
 */
export interface SellerAccessSummary {
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessState;
  readonly stateChangedAt: Temporal.Instant;
}

/** One page of registered seller ids (sellers design R-6, id paging for the backfill). */
export interface RegisteredSellerPage {
  readonly items: readonly {
    readonly sellerId: Id<'Seller'>;
    readonly origin: 'self' | 'invitation';
  }[];
  /** The `after` of the next page, or null after the last page. */
  readonly next: Id<'Seller'> | null;
}

/** A request the contract refused before any read: a code and the fields, never their values. */
export interface FacadeValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/**
 * The answer of `notifyAccessReviewers` (identity design 8.7; request R-3). No recipient count
 * and no address is ever returned. `sellers` keeps its coalescing reservation only on `sent`.
 */
export type ReviewerNoticeOutcome =
  | { readonly code: 'reviewer-notice.sent' }
  | {
      readonly code: 'reviewer-notice.skipped';
      readonly reason: 'seller.unknown' | 'seller.not-pending' | 'recipients.none';
    };

/** The notice could not be sent to anyone (read failed, or no send succeeded): retry later. */
export interface ReviewerNoticeUnavailable {
  readonly code: 'reviewer-notice.unavailable';
}

/**
 * A decision on a seller's access through the contract (identity design 3.3, 8.1, 8.4; slice 9):
 * ids and codes, never the reason.
 */
export interface SellerAccessDecisionOutcome {
  readonly code: 'seller-access.approved' | 'seller-access.rejected';
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessState;
  /** The recorded decision; it carries the `basisId` given (ADR-0022 decision 4). */
  readonly decisionId: Id<'AccessDecision'>;
}

/** Why a decision was refused (identity design 3.3, 8.6 row 1). */
export type SellerAccessDecisionRefusal =
  /** No registered seller with this id in the context's Market. */
  | { readonly code: 'seller.unknown' }
  | { readonly code: 'seller-access.wrong-state' }
  | { readonly code: 'seller-access.reason-required' }
  /** Approve: the seller has no owner account with a verified email. */
  | { readonly code: 'seller-access.owner-unverified' }
  /** The reason's length or characters (HF13): the rule, never the text. */
  | { readonly code: 'validation.failed'; readonly rule: 'length' | 'characters' };

/** A re-application through the contract (identity design 3.3; slice 9). */
export interface SellerReapplyOutcome {
  readonly code: 'seller-access.reapplied';
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessState;
  readonly reapplyCount: number;
}

/** Why a re-application was refused (3.3): not rejected, or the Market's limit is reached. */
export type SellerReapplyRefusal =
  { readonly code: 'seller-access.wrong-state' } | { readonly code: 'seller-access.reapply-limit' };

/**
 * The calls of `identity` that only `sellers` consumes. Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs.
 */
export interface SellerAccessContract {
  /**
   * The access of up to 100 sellers (slice 5; ADR-0022 decision 2): only registered sellers of
   * the context's Market are answered. Two use cases behind this method: `anonymous` for a
   * request actor (the gate passes the anonymous actor), `system` for the system actor.
   *
   * Consumers must reduce the answer to may-sell or may-not-sell (an absent seller may not
   * sell) and never show the state or `stateChangedAt` to a buyer, nor put them in a buyer
   * response, event or log (Hassan I1, slice 5 review).
   */
  sellerAccessOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<readonly SellerAccessSummary[], AccessDenied | FacadeValidationFailed>>;

  /**
   * Registered sellers by id, with their origin, for the system actor only (sellers design R-6,
   * id paging; slice 5): `after` is the last id of the previous page, `limit` 1 to 500.
   */
  listRegisteredSellers(
    context: CallContext,
    page: { readonly after: Id<'Seller'> | null; readonly limit: number },
  ): Promise<Result<RegisteredSellerPage, AccessDenied | FacadeValidationFailed>>;

  /**
   * Tells the admins who may approve that a seller application waits for review (identity
   * design 8.7; `ux.md` E3; request R-3), for the system actor only: `sellers` calls it from its
   * `sellers.after-submission` handler after an onboarding submission, with the dispatcher's
   * context unchanged. The Market comes only from the context. A seller of another Market, a
   * never-issued id and an unregistered seller all answer `skipped / seller.unknown`, the same;
   * a seller that is not `pending` answers `skipped / seller.not-pending`.
   *
   * Not idempotent by itself: a repeated call sends again. The caller coalesces (sellers
   * `rate_counters`, kinds `reviewer-notice.seller` and `reviewer-notice.market`) and keeps its
   * reservation only on `reviewer-notice.sent`. Bounded to 20 seconds in all; on
   * `reviewer-notice.unavailable` nothing was sent and the caller retries.
   */
  notifyAccessReviewers(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<ReviewerNoticeOutcome, AccessDenied | FacadeValidationFailed | ReviewerNoticeUnavailable>
  >;

  /**
   * Approves a pending seller (identity design 3.3, 8.1, 8.4; ADR-0022 decision 4; slice 9):
   * `sellers`' review calls it with the reviewer's context unchanged (permission
   * `identity.seller-access.approve`, checked again in `identity`'s unit) and the id of the
   * submission it approves as `basisId`, required here (sellers design R-1, Ali change 4).
   * `identity` stores it on the decision and publishes it in `identity.seller-access-approved.v1`.
   */
  approveSellerAccess(
    context: CallContext,
    sellerId: Id<'Seller'>,
    basisId: Id,
  ): Promise<Result<SellerAccessDecisionOutcome, AccessDenied | SellerAccessDecisionRefusal>>;

  /**
   * Rejects a pending seller with a reason (3.3, decision 9; slice 9), as approve: `basisId`
   * required. The reason is stored only encrypted and mailed to the Seller Owner; `sellers` must
   * not store, log or put it in an event.
   */
  rejectSellerAccess(
    context: CallContext,
    sellerId: Id<'Seller'>,
    reason: string,
    basisId: Id,
  ): Promise<Result<SellerAccessDecisionOutcome, AccessDenied | SellerAccessDecisionRefusal>>;

  /**
   * A rejected seller applies again (3.3; slice 9): `sellers`' "submit again" calls it with the
   * Seller Owner's own context unchanged (rule `own-resources`, allowed while not approved; the
   * seller must be the actor's). `access.unavailable` while the Market configures no re-apply
   * limit.
   */
  reapplySellerAccess(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<SellerReapplyOutcome, AccessDenied | SellerReapplyRefusal>>;
}

/** Nest token of the {@link SellerAccessContract}, provided and exported by `IdentityModule`. */
export const SELLER_ACCESS_CONTRACT = Symbol('SELLER_ACCESS_CONTRACT');
