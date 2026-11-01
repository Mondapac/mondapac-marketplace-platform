import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import { listCredits, type CreditPage } from '../credit-read-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

export type { CreditPage };

/** `promotions.list-promotion-credits`: the wallet credits a referral or cashback promotion has made (admin manager). */
export class ListPromotionCredits extends UseCase<
  {
    readonly promotionId?: unknown;
    readonly limit?: unknown;
    readonly cursor?: unknown;
  },
  CreditPage,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-promotion-credits',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: {
      readonly promotionId?: unknown;
      readonly limit?: unknown;
      readonly cursor?: unknown;
    },
  ): Promise<Result<CreditPage, PromotionsFailure>> {
    return listCredits(this.deps, context, input);
  }
}
