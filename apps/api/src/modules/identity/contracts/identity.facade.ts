import type { CallContext, Id, Population, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * Who the calling actor is (identity design 8.1 `describeActor`): ids and codes only, never a
 * name or an email. The role and the seller's access state are read from slice 5, the effective
 * permission keys from slice 8a-1 (sorted); `secondFactorActive` says whether the account's second
 * factor is active (slice 7b).
 */
export interface ActorDescription {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  readonly sellerId: Id<'Seller'> | null;
  readonly roleId: string | null;
  readonly permissionKeys: readonly string[];
  readonly sellerAccessState: string | null;
  readonly secondFactorActive: boolean;
}

/** Why {@link IdentityFacade.confirmSecondFactor} refused. Codes and field paths only. */
export type ConfirmSecondFactorFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'second-factor.invalid' }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number }
  /** The account has no active second factor. */
  | { readonly code: 'second-factor.unavailable' }
  | { readonly code: 'session.invalid' }
  | { readonly code: 'access.unavailable' };

/** The seller an account works for, and its role (8.1 `membershipOf`); null when none. */
export type SellerMembershipSummary = {
  readonly sellerId: Id<'Seller'>;
  readonly roleId: Id<'Role'> | null;
} | null;

/** Whose address {@link IdentityFacade.contactEmailOf} reads. */
export type ContactEmailTarget =
  | { readonly kind: 'customer'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'seller-owner'; readonly sellerId: Id<'Seller'> };

/**
 * The public facade of `identity` (identity design 8.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs (PF 6.4
 * row 2). Other modules inject {@link IDENTITY_FACADE}; they never read identity's tables.
 */
export interface IdentityFacade {
  /** Rule `own-resources`, allowed when the seller is not approved. */
  describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>>;

  /**
   * The active membership of `accountId` and its role, or null. For the actor's own account
   * (slice 5): rule `own-resources`, allowed when the seller is not approved. For another account
   * (slice 8a-1): rule `identity.team-member.view`, seller scope, denied while the seller is not
   * approved; an account outside the actor's own team answers null, as one without a membership.
   */
  membershipOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<SellerMembershipSummary, AccessDenied>>;

  /**
   * A recent confirmation of the signed-in seller-side holder: `code` is a current code from the
   * authenticator app or a recovery code. It is counted on the sign-in code throttle and spent
   * once, and nothing else changes. Rule `own-resources`, denied while the seller is not
   * approved. Refusals: `second-factor.invalid`, `second-factor.locked` (with the wait) and
   * `second-factor.unavailable` (no active factor). The code is never logged or stored.
   */
  confirmSecondFactor(
    context: CallContext,
    code: string,
  ): Promise<Result<void, ConfirmSecondFactorFailure>>;

  /**
   * The address to mail a notice to, for the `system` caller only (the order emails): a customer
   * account's own, or a seller Owner's. `null` when there is none to use: unknown, of another
   * Market or population, disabled or not verified, all alike. Personal data: the caller uses it
   * for one send and never logs, stores or puts it in an event.
   */
  contactEmailOf(
    context: CallContext,
    target: ContactEmailTarget,
  ): Promise<Result<string | null, AccessDenied>>;
}

/** Nest token of the {@link IdentityFacade}, provided and exported by `IdentityModule`. */
export const IDENTITY_FACADE = Symbol('IDENTITY_FACADE');
