import { ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  AccessDecision,
  AccessDeclaration,
  AuthorisationCheck,
} from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import { holdsEvery, type EffectiveKeyResolver } from './effective-keys';

const ALLOWED: AccessDecision = Object.freeze({ allowed: true });
const DENIED: AccessDecision = Object.freeze({
  allowed: false,
  denial: Object.freeze({ code: 'access.denied' }),
});

export interface AccountAuthorisationCheckDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
  /** The account's role, read in the check's own read-only unit (slice 8a-1). */
  readonly grants: RoleGrantReader;
  /**
   * The effective-key resolver: in production the one bound to `EFFECTIVE_KEY_RESOLVER`,
   * `effectiveKeysOf` over the permission registry, which the reviewer rule takes too (N-1).
   */
  readonly effectiveKeys: EffectiveKeyResolver;
}

/**
 * identity's {@link AuthorisationCheck} (identity design 5.2; platform-foundations 6.3). The gate
 * calls it for an authenticated actor under `own-resources` or `permissions`. It reads committed
 * state on each call, in one read-only unit of its own and never inside the caller's (PN3), and
 * caches nothing (R4):
 *
 * - the account exists in the actor's Market, has the actor's population and is active;
 * - for the seller population: the account's active membership is of the actor's seller, and
 *   that seller exists and is not `suspended`; a `pending` or `rejected` seller is
 *   `access.seller-not-approved` with its state, unless the declaration says
 *   `whenSellerNotApproved: 'allow'` (the allow-list of 5.2; decision 6, AC 4);
 * - `own-resources`: then allowed;
 * - `permissions` (slice 8a-1): allowed only when the actor holds every listed key. The keys are
 *   `effectiveKeysOf` the account's role (its assignment, read in the same unit) over the
 *   permission registry: a key the registry does not declare, or declares in another scope than
 *   the population's, is never held (R2, R7), so no separate scope test can disagree with it.
 *
 * A customer never holds a key (R2): a `permissions` rule is denied to one before any read. An
 * exception propagates; the gate turns it into `access.unavailable` (fail closed).
 */
export class AccountAuthorisationCheck implements AuthorisationCheck {
  constructor(private readonly deps: AccountAuthorisationCheckDependencies) {}

  async check(context: CallContext, declaration: AccessDeclaration): Promise<AccessDecision> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return DENIED;
    const rule = declaration.rule;
    if (rule.kind !== 'own-resources' && rule.kind !== 'permissions') return DENIED;
    const required = rule.kind === 'permissions' ? rule.allOf : null;
    if (required !== null && actor.population === 'customer') return DENIED;
    const seller = actor.population === 'seller';
    if (seller && actor.sellerId === null) return DENIED;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          account: await this.deps.accounts.findById(market, actor.accountId),
          membership: seller
            ? await this.deps.memberships.findActiveByAccount(market, actor.accountId)
            : null,
          access:
            seller && actor.sellerId !== null
              ? await this.deps.sellerAccess.findById(market, actor.sellerId)
              : null,
          grant:
            required === null
              ? null
              : ((await this.deps.grants.grantsOf(market, [actor.accountId])).get(
                  actor.accountId,
                ) ?? null),
        }),
      { readOnly: true },
    );
    if (!read.ok) return DENIED;
    const { account, membership, access, grant } = read.value;
    if (
      account === null ||
      account.state.marketId !== market.marketId ||
      account.state.population !== actor.population ||
      account.state.status !== 'active'
    ) {
      return DENIED;
    }
    if (seller) {
      if (
        membership === null ||
        membership.state.sellerId !== actor.sellerId ||
        access === null ||
        !access.allowsSignIn
      ) {
        return DENIED;
      }
      const state = access.state.state;
      if (
        (state === 'pending' || state === 'rejected') &&
        declaration.whenSellerNotApproved !== 'allow'
      ) {
        return {
          allowed: false,
          denial: { code: 'access.seller-not-approved', details: { state } },
        };
      }
    }
    if (required === null) return ALLOWED;
    const held = this.deps.effectiveKeys({
      population: actor.population,
      accountId: actor.accountId,
      sellerId: actor.sellerId,
      grant,
    });
    return holdsEvery(held, required) ? ALLOWED : DENIED;
  }
}
