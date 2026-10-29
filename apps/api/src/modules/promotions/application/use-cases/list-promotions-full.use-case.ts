import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { listFull } from '../read-flow';
import type { PromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.list-promotions-full`: the promotions list with terms, budget and the money used. */
export class ListPromotionsFull extends UseCase<
  { readonly status?: unknown; readonly limit?: unknown },
  readonly PromotionView[],
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-promotions-full',
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
    input: { readonly status?: unknown; readonly limit?: unknown },
  ): Promise<Result<readonly PromotionView[], PromotionsFailure>> {
    return listFull(this.deps, context, input);
  }
}

export type { PromotionView } from '../views';
