import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import { campaignMembers, type CampaignMembers } from '../admin-read-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.view-campaign-members`: the sellers of a co-funded campaign, with their opt-in dates. */
export class ViewCampaignMembers extends UseCase<
  { readonly promotionId?: unknown },
  CampaignMembers,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-campaign-members',
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
    input: { readonly promotionId?: unknown },
  ): Promise<Result<CampaignMembers, PromotionsFailure>> {
    return campaignMembers(this.deps, context, input);
  }
}

export type { CampaignMembers } from '../admin-read-flow';
