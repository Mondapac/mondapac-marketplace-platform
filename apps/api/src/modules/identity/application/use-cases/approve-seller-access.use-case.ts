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

export type {
  SellerAccessDecided,
  SellerAccessDecisionFailure,
  SellerAccessDecisionInput,
} from '../sellers/seller-access-decision';

/**
 * Approves a pending seller (identity design 3.3 `pending` → `approved`; SEL-03, AC 4, AC 9;
 * slice 9). Rule `permissions [identity.seller-access.approve]`. Guard: the seller has an owner
 * account with a verified email. The result mail (`ux.md` E4) follows from the event. Phase 2
 * entry: the admin route, with no `basisId`; with `sellers`, its review calls the seller-access
 * contract with the submission id (ADR-0022 decision 4). See `decideSellerAccess` for the unit.
 */
export class ApproveSellerAccess extends UseCase<
  SellerAccessDecisionInput,
  SellerAccessDecided,
  SellerAccessDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.approve-seller-access',
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
    return decideSellerAccess(this.deps, context, input, 'approve', SELLER_ACCESS_APPROVE.key);
  }
}
