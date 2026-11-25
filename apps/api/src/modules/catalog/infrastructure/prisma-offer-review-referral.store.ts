import type { Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OfferReviewQueueFacts,
  OfferReviewReferral,
  OfferReviewReferralStore,
} from '../application/ports/offer-review';
import type { OfferReviewReason } from '../domain/offer-review-policy';

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
        pendingChangeId: referral.pendingChangeId ?? null,
      },
      select: { id: true },
    });
  }
}

/**
 * {@link OfferReviewQueueFacts} over Prisma, in the caller's unit: one read of the referrals (the
 * unique `(market_id, offer_id, offer_version, trigger)` serves it) and one of the open tags (the
 * open-tag partial unique), for a page of at most a few hundred Offers.
 */
export class PrismaOfferReviewQueueFacts implements OfferReviewQueueFacts {
  constructor(private readonly prisma: PrismaService) {}

  async firstPublicationReasons(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<string, readonly OfferReviewReason[]>> {
    const found = new Map<string, readonly OfferReviewReason[]>();
    if (offerIds.length === 0) return found;
    const rows = await this.prisma.tx(market).catalogOfferReviewReferral.findMany({
      where: {
        marketId: market.marketId,
        offerId: { in: [...new Set(offerIds)] },
        trigger: 'first-publication',
      },
      select: { offerId: true, reasons: true },
      orderBy: [{ offerId: 'asc' }, { offerVersion: 'desc' }],
    });
    // The first row of each Offer is its latest decision.
    for (const row of rows) {
      if (!found.has(row.offerId)) {
        found.set(row.offerId, Object.freeze([...row.reasons]) as readonly OfferReviewReason[]);
      }
    }
    return found;
  }

  async pendingFirstPublicationsWithReasons(
    market: MarketContext,
    reasons: readonly OfferReviewReason[],
  ): Promise<readonly Id<'Offer'>[]> {
    if (reasons.length === 0) return [];
    // Every first-publication referral of the Offers that wait now (the relation filter keeps the
    // pending rows; the unique `(market_id, offer_id, offer_version, trigger)` orders each Offer's
    // own), then the latest per Offer decides.
    const rows = await this.prisma.tx(market).catalogOfferReviewReferral.findMany({
      where: {
        marketId: market.marketId,
        trigger: 'first-publication',
        offer: { is: { marketId: market.marketId, status: 'pending-first-publish' } },
      },
      select: { offerId: true, reasons: true },
      orderBy: [{ offerId: 'asc' }, { offerVersion: 'desc' }],
    });
    const wanted = new Set<string>(reasons);
    const seen = new Set<string>();
    const matched: Id<'Offer'>[] = [];
    for (const row of rows) {
      if (seen.has(row.offerId)) continue;
      seen.add(row.offerId);
      if (row.reasons.some((reason) => wanted.has(reason)))
        matched.push(row.offerId as Id<'Offer'>);
    }
    return matched;
  }

  async openTagTypes(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const found = new Map<string, Set<string>>();
    if (offerIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).catalogOfferTag.findMany({
      where: {
        marketId: market.marketId,
        offerId: { in: [...new Set(offerIds)] },
        status: { not: 'removed' },
      },
      select: { offerId: true, typeCode: true },
    });
    for (const row of rows) {
      const types = found.get(row.offerId) ?? new Set<string>();
      types.add(row.typeCode);
      found.set(row.offerId, types);
    }
    return new Map(
      [...found].map(([offerId, types]) => [offerId, Object.freeze([...types].sort())] as const),
    );
  }
}
