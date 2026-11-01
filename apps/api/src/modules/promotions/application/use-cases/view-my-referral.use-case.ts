import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';
import { viewMyReferral, type MyReferralView } from '../referral-flow';

export type { MyReferralView };

/**
 * `promotions.view-my-referral`: the signed-in customer's own referral code with the program's
 * terms and their counts. Rule `own-resources` (customers only). The code is made on the first ask.
 */
export class ViewMyReferral extends UseCase<
  Record<string, never>,
  MyReferralView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-my-referral',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<MyReferralView, PromotionsFailure>> {
    return viewMyReferral(this.deps, context);
  }
}
