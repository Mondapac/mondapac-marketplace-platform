import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_OWN_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { setOptIn } from '../review-flow';
import type { Id } from '@mondapac/shared-kernel';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.set-co-funding-opt-in`: a seller opts in to, or withdraws from, a co-funded campaign; only its own products are in it. */
export class SetCoFundingOptIn extends UseCase<
  { readonly promotionId?: unknown; readonly optIn?: unknown },
  { readonly promotionId: Id<'Promotion'>; readonly optedIn: boolean },
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.set-co-funding-opt-in',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_OWN_PROMOTION_MANAGE.key] },
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
    input: { readonly promotionId?: unknown; readonly optIn?: unknown },
  ): Promise<
    Result<{ readonly promotionId: Id<'Promotion'>; readonly optedIn: boolean }, PromotionsFailure>
  > {
    return setOptIn(this.deps, context, input);
  }
}
