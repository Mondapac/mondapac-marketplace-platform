import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import { promotionActivity, type ActivityPage } from '../admin-read-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

interface Input {
  readonly promotionId?: unknown;
  readonly after?: unknown;
  readonly limit?: unknown;
}

/** `promotions.view-promotion-activity`: who changed a promotion, when, and which terms. */
export class ViewPromotionActivity extends UseCase<Input, ActivityPage, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-promotion-activity',
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
    input: Input,
  ): Promise<Result<ActivityPage, PromotionsFailure>> {
    return promotionActivity(this.deps, context, input);
  }
}

export type { ActivityPage } from '../admin-read-flow';
