import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ACCESS_APPROVE } from '../../contracts/permissions';
import {
  decideSellerAccess,
  type SellerAccessDecided,
  type SellerAccessDecisionDependencies,
  type SellerAccessDecisionFailure,
  type SellerAccessDecisionInput,
} from '../sellers/seller-access-decision';

/**
 * Rejects a pending seller with a reason (identity design 3.3 `pending` → `rejected`; decision 9,
 * AC 6, AC 18; slice 9). Rule `permissions [identity.seller-access.approve]` (one decision with
 * approve, 5.3). The reason is stored only encrypted under the seller's key; every session of the
 * seller's accounts ends; the owner is mailed the reason (`ux.md` E5). See `decideSellerAccess`.
 */
export class RejectSellerAccess extends UseCase<
  SellerAccessDecisionInput,
  SellerAccessDecided,
  SellerAccessDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reject-seller-access',
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_APPROVE.key] },
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
    return decideSellerAccess(this.deps, context, input, 'reject', SELLER_ACCESS_APPROVE.key);
  }
}
