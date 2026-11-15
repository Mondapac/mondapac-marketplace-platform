import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_VIEW } from '../../contracts/permissions';
import { listCreditsOfCustomer, type CreditPage } from '../credit-read-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

type Input = {
  readonly customerAccountId?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
};

/** `promotions.list-customer-promotion-credits`: the credits one customer received from promotions (admin viewer; the admin customer page). */
export class ListCustomerPromotionCredits extends UseCase<Input, CreditPage, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-customer-promotion-credits',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<CreditPage, PromotionsFailure>> {
    return listCreditsOfCustomer(this.deps, context, input);
  }
}
