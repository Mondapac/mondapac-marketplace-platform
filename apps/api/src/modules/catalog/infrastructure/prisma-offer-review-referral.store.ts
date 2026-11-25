import type { IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OfferReviewReferral,
  OfferReviewReferralStore,
} from '../application/ports/offer-review';

/**
 * {@link OfferReviewReferralStore} over Prisma: one insert into `catalog.offer_review_referrals`
 * in the caller's unit. Insert-only (triggers refuse UPDATE, DELETE and TRUNCATE).
 */
export class PrismaOfferReviewReferralStore implements OfferReviewReferralStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async record(market: MarketContext, referral: OfferReviewReferral): Promise<void> {
    await this.prisma.tx(market).catalogOfferReviewReferral.create({
      data: {
        id: this.ids.next<'OfferReviewReferral'>(),
        marketId: market.marketId,
        tenantId: market.tenantId,
        offerId: referral.offerId,
        sellerId: referral.sellerId,
        offerVersion: referral.offerVersion,
        trigger: referral.trigger,
        reasons: [...referral.reasons],
        policyVersion: referral.policyVersion,
        decidedAt: new Date(referral.decidedAt.epochMilliseconds),
      },
      select: { id: true },
    });
  }
}
