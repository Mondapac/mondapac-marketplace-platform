import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AvailabilitySignalRepository,
  NewAvailabilitySignal,
} from '../application/ports/availability-signal.repository';
import type { AvailabilityStatus } from '../domain/events';
import type { StoredSignal } from '../domain/stock';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link AvailabilitySignalRepository} on `inventory.availability_signals` (data design 3.9). A
 * creation race ends in `P2002` under the unique key; under the stock lock of the sell unit it
 * needs a bug, so it is not mapped.
 */
export class PrismaAvailabilitySignalRepository implements AvailabilitySignalRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<StoredSignal | null> {
    const row = await this.prisma.tx(market).inventoryAvailabilitySignal.findFirst({
      where: { marketId: market.marketId, offerId, variantId },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'AvailabilitySignal'>,
      status: row.status as AvailabilityStatus,
      onlyLeft: row.onlyLeft,
      version: row.version,
    };
  }

  async insert(market: MarketContext, signal: NewAvailabilitySignal): Promise<void> {
    await this.prisma.tx(market).inventoryAvailabilitySignal.createMany({
      data: [
        {
          id: signal.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: signal.offerId,
          variantId: signal.variantId,
          sellerId: signal.sellerId,
          status: signal.status,
          onlyLeft: signal.onlyLeft,
          changedAt: toDate(signal.changedAt),
          version: signal.version,
        },
      ],
    });
  }

  async update(
    market: MarketContext,
    id: Id<'AvailabilitySignal'>,
    expectedVersion: number,
    change: {
      readonly status: AvailabilityStatus;
      readonly onlyLeft: number | null;
      readonly changedAt: Temporal.Instant;
      readonly version: number;
    },
  ): Promise<'saved' | 'stale'> {
    const { count } = await this.prisma.tx(market).inventoryAvailabilitySignal.updateMany({
      where: { marketId: market.marketId, id, version: expectedVersion },
      data: {
        status: change.status,
        onlyLeft: change.onlyLeft,
        changedAt: toDate(change.changedAt),
        version: change.version,
      },
    });
    return count === 1 ? 'saved' : 'stale';
  }
}
