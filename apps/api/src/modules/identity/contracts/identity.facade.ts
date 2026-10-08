import type { CallContext, Id, Population, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * Who the calling actor is (identity design 8.1 `describeActor`): ids and codes only, never a
 * name or an email. Roles, permission keys, the seller's access state and the second factor
 * arrive with slices 5, 7 and 8a; until then they are null, empty or false.
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

/**
 * The public facade of `identity` (identity design 8.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs (PF 6.4
 * row 2). Other modules inject {@link IDENTITY_FACADE}; they never read identity's tables.
 */
export interface IdentityFacade {
  /** Rule `own-resources`, allowed when the seller is not approved. */
  describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>>;
}

/** Nest token of the {@link IdentityFacade}, provided and exported by `IdentityModule`. */
export const IDENTITY_FACADE = Symbol('IDENTITY_FACADE');
