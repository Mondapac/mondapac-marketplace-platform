import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WriteRateCounterRepository } from '../application/ports/write-rate-counter.repository';
import {
  WRITE_RATE_COUNTER_KINDS,
  writeWindowRestartBefore,
  type WriteRateLimit,
  type WriteRateReservation,
} from '../domain/write-rate-limits';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link WriteRateCounterRepository} on `pricing.write_rate_counters`, the pattern of the sellers
 * and inventory counters. Per counter, two statements: an `updateMany` that restarts a window
 * that has ended, then an `upsert` on the primary key that Prisma sends as one
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so concurrent units count every attempt
 * exactly once. The kinds are taken in sorted order, so two units never wait in a cycle.
 */
export class PrismaWriteRateCounterRepository implements WriteRateCounterRepository {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    market: MarketContext,
    accountId: Id<'Account'>,
    limits: readonly WriteRateLimit[],
    now: Temporal.Instant,
  ): Promise<readonly WriteRateReservation[]> {
    const transaction = this.prisma.tx(market);
    const reserved = new Map<WriteRateLimit, WriteRateReservation>();
    for (const limit of [...limits].sort((a, b) => (a.kind < b.kind ? -1 : 1))) {
      const { kind } = limit;
      if (!(WRITE_RATE_COUNTER_KINDS as readonly string[]).includes(kind)) {
        throw new TypeError('reserve: unknown write rate counter kind');
      }
      await transaction.pricingWriteRateCounter.updateMany({
        where: {
          marketId: market.marketId,
          kind,
          actorAccountId: accountId,
          windowStartedAt: { lte: toDate(writeWindowRestartBefore(limit, now)) },
        },
        data: { count: 0, windowStartedAt: toDate(now) },
      });
      const row = await transaction.pricingWriteRateCounter.upsert({
        where: {
          marketId: market.marketId,
          marketId_kind_actorAccountId: {
            marketId: market.marketId,
            kind,
            actorAccountId: accountId,
          },
        },
        create: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind,
          actorAccountId: accountId,
          windowStartedAt: toDate(now),
          count: 1,
        },
        update: { count: { increment: 1 } },
        select: { count: true, windowStartedAt: true },
      });
      reserved.set(limit, {
        kind,
        count: row.count,
        windowStartedAt: toInstant(row.windowStartedAt),
      });
    }
    return limits.map((limit) => reserved.get(limit)!);
  }

  async purgeStartedBefore(
    market: MarketContext,
    startedBefore: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).pricingWriteRateCounter.deleteMany({
      where: { marketId: market.marketId, windowStartedAt: { lt: toDate(startedBefore) } },
    });
    return count;
  }
}
