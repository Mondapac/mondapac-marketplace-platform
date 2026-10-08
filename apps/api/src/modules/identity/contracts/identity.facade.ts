import type { CallContext, Id, Population, Result } from '@mondapac/shared-kernel';
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

/** The seller an account works for, and its role (8.1 `membershipOf`); null when none. */
export type SellerMembershipSummary = {
  readonly sellerId: Id<'Seller'>;
  readonly roleId: Id<'Role'> | null;
} | null;

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
}

/** Nest token of the {@link IdentityFacade}, provided and exported by `IdentityModule`. */
export const IDENTITY_FACADE = Symbol('IDENTITY_FACADE');
