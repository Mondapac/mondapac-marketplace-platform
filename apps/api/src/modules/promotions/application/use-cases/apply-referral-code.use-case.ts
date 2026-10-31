import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';
import { applyReferralCode, type AppliedReferral } from '../referral-flow';

export type { AppliedReferral };

/**
 * `promotions.apply-referral-code`: a new customer applies a referrer's code. Rule `own-resources`
 * (customers only; the account is the session's). Needs the Market switch on; the customer must
 * not have ordered before (asked of the owner, fail closed), must not be the code's owner and
 * must not have been referred already.
 */
export class ApplyReferralCode extends UseCase<
  { readonly code?: unknown },
  AppliedReferral,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.apply-referral-code',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly code?: unknown },
  ): Promise<Result<AppliedReferral, PromotionsFailure>> {
    return applyReferralCode(this.deps, context, input);
  }
}
