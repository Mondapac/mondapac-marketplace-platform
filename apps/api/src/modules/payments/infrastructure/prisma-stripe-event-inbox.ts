import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  EventOutcome,
  KeptEventType,
  PendingEvent,
  ReceivedEvent,
  StripeEventInbox,
} from '../application/ports/stripe-event-inbox';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** `payments.stripe_events` through the unit of work's transaction. */
export class PrismaStripeEventInbox implements StripeEventInbox {
  constructor(private readonly prisma: PrismaService) {}

  async record(market: MarketContext, event: ReceivedEvent): Promise<'recorded' | 'duplicate'> {
    const created = await this.prisma.tx(market).paymentsStripeEvent.createMany({
      data: [
        {
          eventId: event.eventId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          type: event.type,
          objectId: event.objectId,
          receivedAt: toDate(event.receivedAt),
          attempts: 0,
          nextAttemptAt: toDate(event.receivedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'recorded' : 'duplicate';
  }

  async due(market: MarketContext, now: Temporal.Instant, limit: number): Promise<PendingEvent[]> {
    const rows = await this.prisma.tx(market).paymentsStripeEvent.findMany({
      where: { marketId: market.marketId, processedAt: null, nextAttemptAt: { lte: toDate(now) } },
      orderBy: [{ nextAttemptAt: 'asc' }, { eventId: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      eventId: row.eventId,
      type: row.type as KeptEventType,
      objectId: row.objectId,
      receivedAt: toInstant(row.receivedAt),
      attempts: row.attempts,
    }));
  }

  async finish(
    market: MarketContext,
    eventId: string,
    outcome: EventOutcome,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsStripeEvent.updateMany({
      where: { marketId: market.marketId, eventId, processedAt: null },
      data: { processedAt: toDate(at), outcome },
    });
    return updated.count === 1;
  }

  async retryLater(
    market: MarketContext,
    eventId: string,
    attempts: number,
    nextAttemptAt: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).paymentsStripeEvent.updateMany({
      where: { marketId: market.marketId, eventId, processedAt: null },
      data: { attempts, nextAttemptAt: toDate(nextAttemptAt) },
    });
  }
}
