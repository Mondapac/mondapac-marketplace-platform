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
 * Suspends an approved seller with a reason (identity design 3.3 `approved` → `suspended`;
 * SEL-07, AC 14, AC 18; slice 9). Rule `permissions [identity.seller-access.suspend]`. Every
 * session of the seller's accounts ends and their open challenges are void (HF11); no account of
 * the seller signs in while suspended; the owner is mailed the reason (`ux.md` E6). See
 * `decideSellerAccess` for the unit.
 */
export class SuspendSellerAccess extends UseCase<
  SellerAccessDecisionInput,
  SellerAccessDecided,
  SellerAccessDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.suspend-seller-access',
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
    return decideSellerAccess(this.deps, context, input, 'suspend', SELLER_ACCESS_SUSPEND.key);
  }
}
