import { Temporal, money } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { DeliveryQuoteRepository } from '../application/ports/delivery-quote.repository';
import type { CarrierMethod } from '../domain/booking-service';
import type { DeliveryQuote, QuoteScope } from '../domain/delivery-quote';
import type { FleetCode } from '../domain/fleet';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly accountId: string;
  readonly sellerId: string;
  readonly method: string;
  readonly dropoffPostcode: string;
  readonly fleet: string;
  readonly quoteAmount: bigint;
  readonly marginAmount: bigint;
  readonly totalAmount: bigint;
  readonly currency: string;
  readonly etaMinutes: number | null;
  readonly quotedAt: Date;
  readonly fleetExpiresAt: Date | null;
  readonly validUntil: Date;
}

const toQuote = (row: Row): DeliveryQuote => ({
  id: row.id as Id<'DeliveryQuote'>,
  accountId: row.accountId as Id<'Account'>,
  sellerId: row.sellerId as Id<'Seller'>,
  // The CHECKs hold the method and the fleet to their closed lists.
  method: row.method as CarrierMethod,
  dropoffPostcode: row.dropoffPostcode,
  fleet: row.fleet as FleetCode,
  quote: money(row.quoteAmount, row.currency),
  margin: money(row.marginAmount, row.currency),
  total: money(row.totalAmount, row.currency),
  etaMinutes: row.etaMinutes,
  quotedAt: toInstant(row.quotedAt),
  fleetExpiresAt: row.fleetExpiresAt === null ? null : toInstant(row.fleetExpiresAt),
  validUntil: toInstant(row.validUntil),
});

/** {@link DeliveryQuoteRepository} on `shipping.delivery_quotes`, scoped by `marketId` in every `where`. */
export class PrismaDeliveryQuoteRepository implements DeliveryQuoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, quote: DeliveryQuote): Promise<void> {
    await this.prisma.tx(market).shippingDeliveryQuote.create({
      data: {
        id: quote.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: quote.accountId,
        sellerId: quote.sellerId,
        method: quote.method,
        dropoffPostcode: quote.dropoffPostcode,
        fleet: quote.fleet,
        quoteAmount: quote.quote.amount,
        marginAmount: quote.margin.amount,
        totalAmount: quote.total.amount,
        currency: quote.total.currency,
        etaMinutes: quote.etaMinutes,
        quotedAt: toDate(quote.quotedAt),
        fleetExpiresAt: quote.fleetExpiresAt === null ? null : toDate(quote.fleetExpiresAt),
        validUntil: toDate(quote.validUntil),
      },
    });
  }

  async findById(market: MarketContext, id: Id<'DeliveryQuote'>) {
    const row = await this.prisma
      .tx(market)
      .shippingDeliveryQuote.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : toQuote(row);
  }

  async findFresh(market: MarketContext, scope: QuoteScope, now: Temporal.Instant) {
    const row = await this.prisma.tx(market).shippingDeliveryQuote.findFirst({
      where: {
        marketId: market.marketId,
        accountId: scope.accountId,
        sellerId: scope.sellerId,
        method: scope.method,
        dropoffPostcode: scope.dropoffPostcode,
        validUntil: { gt: toDate(now) },
      },
      orderBy: [{ quotedAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : toQuote(row);
  }

  async deleteExpired(market: MarketContext, accountId: Id<'Account'>, before: Temporal.Instant) {
    await this.prisma.tx(market).shippingDeliveryQuote.deleteMany({
      where: { marketId: market.marketId, accountId, validUntil: { lt: toDate(before) } },
    });
  }
}
