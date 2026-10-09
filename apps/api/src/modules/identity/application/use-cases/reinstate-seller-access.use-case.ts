import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ACCESS_SUSPEND } from '../../contracts/permissions';
import {
  decideSellerAccess,
  type SellerAccessDecided,
  type SellerAccessDecisionDependencies,
  type SellerAccessDecisionFailure,
  type SellerAccessDecisionInput,
} from '../sellers/seller-access-decision';

/**
 * Reinstates a suspended seller (identity design 3.3 `suspended` → `approved`; AC 14; slice 9).
 * Rule `permissions [identity.seller-access.suspend]`. No reason (data design 3.11: the CHECK
 * allows one only on a rejection or a suspension); the owner is mailed (`ux.md` E7). See
 * `decideSellerAccess` for the unit.
 */
export class ReinstateSellerAccess extends UseCase<
  SellerAccessDecisionInput,
  SellerAccessDecided,
  SellerAccessDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reinstate-seller-access',
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_SUSPEND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerAccessDecisionDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerAccessDecisionInput,
  ): Promise<Result<SellerAccessDecided, SellerAccessDecisionFailure>> {
    return decideSellerAccess(this.deps, context, input, 'reinstate', SELLER_ACCESS_SUSPEND.key);
  }
}
