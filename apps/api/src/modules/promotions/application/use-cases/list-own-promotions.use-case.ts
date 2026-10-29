import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_OWN_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { listOwn } from '../read-flow';
import type { OwnPromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.list-own-promotions`: a seller reads its own promotions with its own usage and money. */
export class ListOwnPromotions extends UseCase<
  { readonly status?: unknown; readonly limit?: unknown },
  readonly OwnPromotionView[],
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-own-promotions',
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
    input: { readonly status?: unknown; readonly limit?: unknown },
  ): Promise<Result<readonly OwnPromotionView[], PromotionsFailure>> {
    return listOwn(this.deps, context, input);
  }
}

export type { OwnPromotionView } from '../views';
