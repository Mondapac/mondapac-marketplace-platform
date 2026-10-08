import { ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  AccessDecision,
  AccessDeclaration,
  AuthorisationCheck,
} from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';

const ALLOWED: AccessDecision = Object.freeze({ allowed: true });
const DENIED: AccessDecision = Object.freeze({
  allowed: false,
  denial: Object.freeze({ code: 'access.denied' }),
});

/**
 * identity's {@link AuthorisationCheck} (identity design 5.2; platform-foundations 6.3), as far
 * as slice 2 goes. The gate calls it for an authenticated actor under `own-resources` or
 * `permissions`. It reads committed state on each call, in a read-only unit of its own and never
 * inside the caller's (PN3), and caches nothing:
 *
 * - the account exists in the actor's Market, has the actor's population and is active;
 * - `own-resources`: allowed for the customer and admin populations. The seller population is
 *   denied until slice 5, which brings the membership, the seller's state and the allow-list
 *   (`whenSellerNotApproved`);
 * - `permissions`: denied until slice 8a, which brings the registry, roles and assignments
 *   (R7: a key no role grants is never held).
 *
 * An exception propagates; the gate turns it into `access.unavailable` (fail closed).
 */
export class AccountAuthorisationCheck implements AuthorisationCheck {
  constructor(
    private readonly deps: {
      readonly unitOfWork: UnitOfWork;
      readonly accounts: AccountRepository;
    },
  ) {}

  async check(context: CallContext, declaration: AccessDeclaration): Promise<AccessDecision> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return DENIED;
    const rule = declaration.rule.kind;
    if (rule !== 'own-resources' || actor.population === 'seller') return DENIED;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.accounts.findById(market, actor.accountId)),
      { readOnly: true },
    );
    const account = read.ok ? read.value : null;
    if (
      account === null ||
      account.state.marketId !== market.marketId ||
      account.state.population !== actor.population ||
      account.state.status !== 'active'
    ) {
      return DENIED;
    }
    return ALLOWED;
  }
}
