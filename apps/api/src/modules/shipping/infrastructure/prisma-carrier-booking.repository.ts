import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CarrierBookingRepository } from '../application/ports/carrier-booking.repository';
import type { CarrierBooking, CarrierProgress } from '../domain/carrier-booking';
import type { FleetCode } from '../domain/fleet';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly sellerOrderId: string;
  readonly orderId: string;
  readonly sellerId: string;
  readonly fleet: string;
  readonly carrierReference: string;
  readonly progress: string;
  readonly carrierStatus: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const toBooking = (row: Row): CarrierBooking => ({
  id: row.id as Id<'CarrierBooking'>,
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
  orderId: row.orderId as Id<'Order'>,
  sellerId: row.sellerId as Id<'Seller'>,
  // The CHECKs hold both to their closed lists.
  fleet: row.fleet as FleetCode,
  carrierReference: row.carrierReference,
  progress: row.progress as CarrierProgress,
  carrierStatus: row.carrierStatus,
  version: row.version,
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
});

/**
 * {@link CarrierBookingRepository} on `shipping.carrier_bookings` and `shipping.carrier_events`,
 * scoped by `marketId` in every `where`.
 */
export class PrismaCarrierBookingRepository implements CarrierBookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findBySellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const row = await this.prisma
      .tx(market)
      .shippingCarrierBooking.findFirst({ where: { marketId: market.marketId, sellerOrderId } });
    return row === null ? null : toBooking(row);
  }

  async insert(market: MarketContext, booking: CarrierBooking): Promise<'inserted' | 'exists'> {
    const created = await this.prisma.tx(market).shippingCarrierBooking.createMany({
      data: [
        {
          id: booking.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerOrderId: booking.sellerOrderId,
          orderId: booking.orderId,
          sellerId: booking.sellerId,
          fleet: booking.fleet,
          carrierReference: booking.carrierReference,
          progress: booking.progress,
          carrierStatus: booking.carrierStatus,
          version: booking.version,
          createdAt: toDate(booking.createdAt),
          updatedAt: toDate(booking.updatedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'inserted' : 'exists';
  }

  async save(
    market: MarketContext,
    booking: CarrierBooking,
    expectedVersion: number,
  ): Promise<'saved' | 'conflict'> {
    const updated = await this.prisma.tx(market).shippingCarrierBooking.updateMany({
      where: { marketId: market.marketId, id: booking.id, version: expectedVersion },
      data: {
        progress: booking.progress,
        carrierStatus: booking.carrierStatus,
        version: booking.version,
        updatedAt: toDate(booking.updatedAt),
      },
    });
    return updated.count === 1 ? 'saved' : 'conflict';
  }

  async recordEvent(
    market: MarketContext,
    event: {
      readonly eventId: string;
      readonly carrier: string;
      readonly receivedAt: Temporal.Instant;
    },
  ): Promise<'recorded' | 'duplicate'> {
    const created = await this.prisma.tx(market).shippingCarrierEvent.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          carrier: event.carrier,
          eventId: event.eventId,
          receivedAt: toDate(event.receivedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'recorded' : 'duplicate';
  }

  async findAttempt(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const row = await this.prisma.tx(market).shippingFleetBookingAttempt.findFirst({
      where: { marketId: market.marketId, sellerOrderId },
    });
    return row === null ? null : (row.fleet as FleetCode);
  }

  async markAttempt(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    fleet: FleetCode,
    at: Temporal.Instant,
  ) {
    await this.prisma.tx(market).shippingFleetBookingAttempt.upsert({
      where: {
        marketId: market.marketId,
        marketId_sellerOrderId: { marketId: market.marketId, sellerOrderId },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerOrderId,
        fleet,
        attemptedAt: toDate(at),
      },
      update: { fleet, attemptedAt: toDate(at) },
    });
  }

  async clearAttempt(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    await this.prisma.tx(market).shippingFleetBookingAttempt.deleteMany({
      where: { marketId: market.marketId, sellerOrderId },
    });
  }
}
