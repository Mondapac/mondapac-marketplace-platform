import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  RetiredOfferTombstone,
  RetiredVariantTombstone,
  RetirementTombstoneRepository,
} from '../application/ports/retirement-tombstone.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link RetirementTombstoneRepository} on `pricing.retired_offers` and
 * `pricing.retired_variants` (pricing-data 3.6): `createMany` with `skipDuplicates`, so a
 * redelivery is a no-op on top of the inbox, and the count says whether this call inserted.
 */
export class PrismaRetirementTombstoneRepository implements RetirementTombstoneRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordRetiredOffer(
    market: MarketContext,
    tombstone: RetiredOfferTombstone,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).pricingRetiredOffer.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: tombstone.offerId,
          retiredAt: toDate(tombstone.retiredAt),
          causeEventId: tombstone.causeEventId,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async recordRetiredVariant(
    market: MarketContext,
    tombstone: RetiredVariantTombstone,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).pricingRetiredVariant.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          productId: tombstone.productId,
          variantId: tombstone.variantId,
          retiredAt: toDate(tombstone.retiredAt),
          causeEventId: tombstone.causeEventId,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }
}
