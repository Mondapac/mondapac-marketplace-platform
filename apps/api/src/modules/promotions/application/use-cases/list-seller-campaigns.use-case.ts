import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_OWN_PROMOTION_MANAGE } from '../../contracts/permissions';
import { listSellerCampaigns, type SellerCampaignView } from '../campaign-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

/**
 * `promotions.list-seller-campaigns`: the open co-funded campaigns a seller may join, each with
 * whether the seller is in, what the seller and the platform pay, and which of the seller's
 * products it covers. An approved seller only; an acting-as session is refused.
 */
export class ListSellerCampaigns extends UseCase<
  Record<string, never>,
  readonly SellerCampaignView[],
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-seller-campaigns',
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
  ): Promise<Result<readonly SellerCampaignView[], PromotionsFailure>> {
    return listSellerCampaigns(this.deps, context);
  }
}

export type { SellerCampaignView } from '../campaign-flow';
