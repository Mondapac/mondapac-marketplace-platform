import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_OWN_PROMOTION_MANAGE } from '../../contracts/permissions';
import { previewSellerPayout, type SellerPayoutPreviewView } from '../campaign-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

interface Input {
  readonly promotionId?: unknown;
  readonly discountBps?: unknown;
  readonly priceMinor?: unknown;
  readonly offerId?: unknown;
  readonly variantId?: unknown;
}

/**
 * `promotions.preview-seller-payout`: what the shopper pays and what the seller gets for one unit
 * at a price under a campaign or under the seller's own percentage sale, with the seller's own
 * commission rate, and whether the earlier price may be shown struck through. It reads the
 * seller's commission rate and, for an Offer, its ownership: it changes nothing. An approved
 * seller only; an acting-as session is refused.
 */
export class PreviewSellerPayout extends UseCase<
  Input,
  SellerPayoutPreviewView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.preview-seller-payout',
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
    input: Input,
  ): Promise<Result<SellerPayoutPreviewView, PromotionsFailure>> {
    return previewSellerPayout(this.deps, context, input);
  }
}

export type { SellerPayoutPreviewView } from '../campaign-flow';
