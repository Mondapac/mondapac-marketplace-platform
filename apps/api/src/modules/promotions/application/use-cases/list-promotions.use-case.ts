import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_VIEW } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { listUsage } from '../read-flow';
import type { PromotionUsageView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.list-promotions`: the promotions list with usage counts only: no cost, budget or share field, so a Viewer may read it. */
export class ListPromotions extends UseCase<
  { readonly status?: unknown; readonly limit?: unknown },
  readonly PromotionUsageView[],
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-promotions',
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
    input: { readonly status?: unknown; readonly limit?: unknown },
  ): Promise<Result<readonly PromotionUsageView[], PromotionsFailure>> {
    return listUsage(this.deps, context, input);
  }
}

export type { PromotionUsageView } from '../views';
