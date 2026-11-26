import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  RateCounter,
  RateCounterRepository,
} from '../application/ports/rate-counter.repository';
import type { RateCounterWindows } from '../application/ports/rate-counter-windows';
import {
  PREVIEW_CONTACT_MARK,
  RATE_COUNTER_KINDS,
  windowRestartBefore,
  type RateReservation,
} from '../domain/rate-limits';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** Kind first, then key bytes: the fixed order of data design 3.26, so no cycle of waits. */
function inLockOrder(a: RateCounter, b: RateCounter): number {
  if (a.limit.kind !== b.limit.kind) return a.limit.kind < b.limit.kind ? -1 : 1;
  return Buffer.compare(a.keyHash, b.keyHash);
}

const KEY_HASH_BYTES = 32;

/**
 * {@link RateCounterRepository} on `catalog.rate_counters` (data design 3.26), the pattern of
 * the sellers module. Per counter, two statements: an `updateMany` that restarts a window that
 * has ended, then an `upsert` on the primary key that Prisma sends as one
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so concurrent units count every attempt
 * exactly once. Nothing is released here.
 */
export class PrismaRateCounterRepository implements RateCounterRepository, RateCounterWindows {
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
      await transaction.catalogRateCounter.updateMany({
        where: {
          marketId: market.marketId,
          kind,
          keyHash,
          windowStartedAt: { lte: toDate(windowRestartBefore(counter.limit, now)) },
        },
        data: { count: 0, windowStartedAt: toDate(now) },
      });
      const row = await transaction.catalogRateCounter.upsert({
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

  async isOpen(
    market: MarketContext,
    counter: RateCounter,
    now: Temporal.Instant,
  ): Promise<boolean> {
    if (!(RATE_COUNTER_KINDS as readonly string[]).includes(counter.limit.kind)) {
      throw new TypeError('isOpen: unknown rate counter kind');
    }
    if (counter.keyHash.length !== KEY_HASH_BYTES) {
      throw new TypeError('isOpen: a key hash is 32 bytes');
    }
    const row = await this.prisma.tx(market).catalogRateCounter.findFirst({
      where: {
        marketId: market.marketId,
        kind: counter.limit.kind,
        keyHash: Uint8Array.from(counter.keyHash),
        windowStartedAt: { gt: toDate(windowRestartBefore(counter.limit, now)) },
        count: { gt: 0 },
      },
      select: { count: true },
    });
    return row !== null;
  }

  /** A mark's window outlives the purge's 48 hours, so marks are never purged here. */
  async purgeStartedBefore(
    market: MarketContext,
    startedBefore: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).catalogRateCounter.deleteMany({
      where: {
        marketId: market.marketId,
        kind: { not: PREVIEW_CONTACT_MARK.kind },
        windowStartedAt: { lt: toDate(startedBefore) },
      },
    });
    return count;
  }
}
