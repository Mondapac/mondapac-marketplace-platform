import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OfferReviewFlagChangeEntry,
  OfferReviewFlagsRepository,
} from '../application/ports/offer-review-flags.repository';
import type {
  OfferReviewFlag,
  OfferReviewFlagsState,
  OfferReviewFlagSwitch,
} from '../domain/offer-review-flags';

const instantOf = (value: Date | null): Temporal.Instant | null =>
  value === null ? null : Temporal.Instant.fromEpochMilliseconds(value.getTime());

const switchOf = (on: boolean, at: Date | null, by: string | null): OfferReviewFlagSwitch => ({
  on,
  changedAt: instantOf(at),
  changedBy: by as Id<'Account'> | null,
});

/** The three columns of one flag on `seller_admin_settings`. */
function columnsOf(flag: OfferReviewFlag, on: boolean, at: Date, by: string) {
  switch (flag) {
    case 'trusted-from-start':
      return {
        offerReviewTrustedFromStart: on,
        offerReviewTrustedFromStartChangedAt: at,
        offerReviewTrustedFromStartChangedByAccountId: by,
      };
    case 'full-review':
      return {
        offerReviewFullReview: on,
        offerReviewFullReviewChangedAt: at,
        offerReviewFullReviewChangedByAccountId: by,
      };
    case 'review-stop':
      return {
        offerReviewStop: on,
        offerReviewStopChangedAt: at,
        offerReviewStopChangedByAccountId: by,
      };
  }
}

/**
 * {@link OfferReviewFlagsRepository} on `sellers.seller_admin_settings` and the insert-only
 * `sellers.offer_review_flag_changes`, by Market. A change is one conditional UPDATE on the row's
 * version (0 rows: another change won) and one INSERT, in the caller's unit.
 */
export class PrismaOfferReviewFlagsRepository implements OfferReviewFlagsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async read(market: MarketContext, sellerId: Id<'Seller'>): Promise<OfferReviewFlagsState | null> {
    const row = await this.prisma.tx(market).sellersSellerAdminSettings.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: {
        offerReviewTrustedFromStart: true,
        offerReviewTrustedFromStartChangedAt: true,
        offerReviewTrustedFromStartChangedByAccountId: true,
        offerReviewFullReview: true,
        offerReviewFullReviewChangedAt: true,
        offerReviewFullReviewChangedByAccountId: true,
        offerReviewStop: true,
        offerReviewStopChangedAt: true,
        offerReviewStopChangedByAccountId: true,
        version: true,
      },
    });
    if (row === null) return null;
    return {
      trustedFromStart: switchOf(
        row.offerReviewTrustedFromStart,
        row.offerReviewTrustedFromStartChangedAt,
        row.offerReviewTrustedFromStartChangedByAccountId,
      ),
      fullReview: switchOf(
        row.offerReviewFullReview,
        row.offerReviewFullReviewChangedAt,
        row.offerReviewFullReviewChangedByAccountId,
      ),
      reviewStop: switchOf(
        row.offerReviewStop,
        row.offerReviewStopChangedAt,
        row.offerReviewStopChangedByAccountId,
      ),
      version: row.version,
    };
  }

  async set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly flag: OfferReviewFlag;
      readonly on: boolean;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
      readonly expectedVersion: number;
    },
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).sellersSellerAdminSettings.updateMany({
      where: { marketId: market.marketId, sellerId, version: change.expectedVersion },
      data: {
        ...columnsOf(change.flag, change.on, new Date(change.at.epochMilliseconds), change.by),
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  async appendChange(market: MarketContext, entry: OfferReviewFlagChangeEntry): Promise<void> {
    await this.prisma.tx(market).sellersOfferReviewFlagChange.create({
      data: {
        id: entry.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: entry.sellerId,
        flag: entry.flag,
        previousValue: entry.previous,
        newValue: entry.next,
        reason: entry.reason,
        changedByAccountId: entry.by,
        changedAt: new Date(entry.at.epochMilliseconds),
      },
      select: { id: true },
    });
  }
}
