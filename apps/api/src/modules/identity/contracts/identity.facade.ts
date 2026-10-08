import type { CallContext, Id, Population, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * Who the calling actor is (identity design 8.1 `describeActor`): ids and codes only, never a
 * name or an email. The role and the seller's access state are read from slice 5; permission
 * keys and the second factor arrive with slices 8a and 7, until then empty and false.
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

/** The seller an account works for, and its role (8.1 `membershipOf`); null when none. */
export type SellerMembershipSummary = {
  readonly sellerId: Id<'Seller'>;
  readonly roleId: Id<'Role'> | null;
} | null;

/** One page of registered seller ids (sellers design R-6, id paging for the backfill). */
export interface RegisteredSellerPage {
  readonly items: readonly {
    readonly sellerId: Id<'Seller'>;
    readonly origin: 'self' | 'invitation';
  }[];
  /** The `after` of the next page, or null after the last page. */
  readonly next: Id<'Seller'> | null;
}

/** A request the facade refused before any read: a code and the fields, never their values. */
export interface FacadeValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/**
 * The public facade of `identity` (identity design 8.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs (PF 6.4
 * row 2). Other modules inject {@link IDENTITY_FACADE}; they never read identity's tables.
 */
export interface IdentityFacade {
  /** Rule `own-resources`, allowed when the seller is not approved. */
  describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>>;

  /**
   * The active membership of `accountId` and its role, or null (slice 5). Rule `own-resources`,
   * allowed when the seller is not approved, **for the actor's own account only**: another id
   * is `access.denied`. The variant for other accounts waits for slice 8a.
   */
  membershipOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<SellerMembershipSummary, AccessDenied>>;

  /**
   * The access of up to 100 sellers (slice 5; ADR-0022 decision 2): only registered sellers of
   * the context's Market are answered. Two use cases behind this method: `anonymous` for a
   * request actor (the gate passes the anonymous actor), `system` for the system actor.
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
}

/** Nest token of the {@link IdentityFacade}, provided and exported by `IdentityModule`. */
export const IDENTITY_FACADE = Symbol('IDENTITY_FACADE');
