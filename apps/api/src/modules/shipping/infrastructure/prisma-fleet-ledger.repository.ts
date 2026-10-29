import type { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  DeliveryFallbackRecord,
  FleetFeeRecord,
  FleetLedgerRepository,
} from '../application/ports/fleet-ledger.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link FleetLedgerRepository} on `shipping.fleet_fees` and `shipping.delivery_fallbacks`: both
 * insert-only, and a repeat is told apart by the table's own unique key (no read first), so two
 * parallel reports of one fee record it once.
 */
export class PrismaFleetLedgerRepository implements FleetLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordFee(market: MarketContext, fee: FleetFeeRecord) {
    const created = await this.prisma.tx(market).shippingFleetFee.createMany({
      data: [
        {
          id: fee.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          fleet: fee.fleet,
          sellerOrderId: fee.sellerOrderId,
          reason: fee.reason,
          amount: fee.amount.amount,
          currency: fee.amount.currency,
          externalRef: fee.externalRef,
          occurredAt: toDate(fee.occurredAt),
          recordedAt: toDate(fee.recordedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? ('recorded' as const) : ('duplicate' as const);
  }

  async recordFallback(market: MarketContext, fallback: DeliveryFallbackRecord) {
    const created = await this.prisma.tx(market).shippingDeliveryFallback.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerOrderId: fallback.sellerOrderId,
          chargedFleet: fallback.chargedFleet,
          bookedFleet: fallback.bookedFleet,
          chargedQuote: fallback.chargedQuote.amount,
          bookedPrice: fallback.bookedPrice === null ? null : fallback.bookedPrice.amount,
          difference: fallback.difference === null ? null : fallback.difference.amount,
          capMinor: fallback.capMinor,
          overCap: fallback.overCap,
          currency: fallback.chargedQuote.currency,
          recordedAt: toDate(fallback.recordedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? ('recorded' as const) : ('exists' as const);
  }
}
