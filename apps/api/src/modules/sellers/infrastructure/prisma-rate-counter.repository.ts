import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  RateCounter,
  RateCounterRepository,
} from '../application/ports/rate-counter.repository';
import {
  RATE_COUNTER_KINDS,
  windowRestartBefore,
  type RateReservation,
} from '../domain/rate-limits';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** Kind first, then key bytes: the fixed order of data design 3.11, so no cycle of waits. */
function inLockOrder(a: RateCounter, b: RateCounter): number {
  if (a.limit.kind !== b.limit.kind) return a.limit.kind < b.limit.kind ? -1 : 1;
  return Buffer.compare(a.keyHash, b.keyHash);
}

const KEY_HASH_BYTES = 32;

/**
 * {@link RateCounterRepository} on `sellers.rate_counters` (data design 3.11), the pattern of
 * identity's throttle counters (ID-data 3.5, spike 6). Per counter, two statements (C10): an
 * `updateMany` that restarts a window that has ended, then an `upsert` on the primary key that
 * Prisma sends as one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so concurrent units
 * count every attempt exactly once. Nothing is released here (only the reviewer-notice kinds of
 * slice 5 release).
 */
export class PrismaRateCounterRepository implements RateCounterRepository {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    market: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]> {
    const transaction = this.prisma.tx(market);
    const reserved = new Map<RateCounter, RateReservation>();
    for (const counter of [...counters].sort(inLockOrder)) {
      const { kind } = counter.limit;
      if (!(RATE_COUNTER_KINDS as readonly string[]).includes(kind)) {
        throw new TypeError('reserve: unknown rate counter kind');
      }
      if (counter.keyHash.length !== KEY_HASH_BYTES) {
        throw new TypeError('reserve: a key hash is 32 bytes');
      }
      const keyHash = Uint8Array.from(counter.keyHash);
      await transaction.sellersRateCounter.updateMany({
        where: {
          marketId: market.marketId,
          kind,
          keyHash,
          windowStartedAt: { lte: toDate(windowRestartBefore(counter.limit, now)) },
        },
        data: { count: 0, windowStartedAt: toDate(now) },
      });
      const row = await transaction.sellersRateCounter.upsert({
        where: {
          marketId: market.marketId,
          marketId_kind_keyHash: { marketId: market.marketId, kind, keyHash },
        },
        create: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind,
          keyHash,
          windowStartedAt: toDate(now),
          count: 1,
        },
        update: { count: { increment: 1 } },
        select: { count: true, windowStartedAt: true },
      });
      reserved.set(counter, {
        kind,
        count: row.count,
        windowStartedAt: toInstant(row.windowStartedAt),
      });
    }
    return counters.map((counter) => reserved.get(counter)!);
  }

  async purgeStartedBefore(
    market: MarketContext,
    startedBefore: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).sellersRateCounter.deleteMany({
      where: { marketId: market.marketId, windowStartedAt: { lt: toDate(startedBefore) } },
    });
    return count;
  }
}
