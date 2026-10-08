import { ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  AccessDecision,
  AccessDeclaration,
  AuthorisationCheck,
} from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import { effectiveKeysOf, holdsEvery, type EffectiveKeyResolver } from './effective-keys';

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
  /**
   * The effective-key resolver; {@link effectiveKeysOf} by default, the one definition the
   * reviewer rule uses too. Tests pass `effectiveKeysOf` with fixture grants and registry.
   */
  readonly keys?: EffectiveKeyResolver;
}

/**
 * identity's {@link AuthorisationCheck} (identity design 5.2; platform-foundations 6.3), as far
 * as slice 5 goes. The gate calls it for an authenticated actor under `own-resources` or
 * `permissions`. It reads committed state on each call, in a read-only unit of its own and never
 * inside the caller's (PN3), and caches nothing:
 *
 * - the account exists in the actor's Market, has the actor's population and is active;
 * - for the seller population (slice 5): the account's active membership is of the actor's
 *   seller, and that seller exists and is not `suspended`; a `pending` or `rejected` seller is
 *   `access.seller-not-approved` with its state, unless the declaration says
 *   `whenSellerNotApproved: 'allow'` (the allow-list of 5.2; decision 6, AC 4);
 * - `own-resources`: then allowed;
 * - `permissions`: allowed only when the actor holds every listed key, by `effectiveKeysOf`, the
 *   one definition the reviewer-notice recipients use too (identity design 8.7; Hassan M2). It
 *   answers no key until slice 8a-1 brings the registry and role keys (R7: a key no role grants
 *   is never held), so every `permissions` rule is denied until then. Outside the seller
 *   population a rule the actor cannot hold is denied before any read; for the seller population
 *   the seller's state is decided first, so a seller that is not approved learns why.
 *
 * An exception propagates; the gate turns it into `access.unavailable` (fail closed).
 */
export class AccountAuthorisationCheck implements AuthorisationCheck {
  constructor(private readonly deps: AccountAuthorisationCheckDependencies) {}

  async check(context: CallContext, declaration: AccessDeclaration): Promise<AccessDecision> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return DENIED;
    const rule = declaration.rule.kind;
    if (rule !== 'own-resources' && rule !== 'permissions') return DENIED;
    const seller = actor.population === 'seller';
    const required = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : null;
    const holdsRequired =
      required === null ||
      holdsEvery(
        (this.deps.keys ?? effectiveKeysOf)({
          population: actor.population,
          accountId: actor.accountId,
        }),
        required,
      );
    if (!seller && !holdsRequired) return DENIED;
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
        }),
      { readOnly: true },
    );
    if (!read.ok) return DENIED;
    const { account, membership, access } = read.value;
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
    return holdsRequired ? ALLOWED : DENIED;
  }
}
