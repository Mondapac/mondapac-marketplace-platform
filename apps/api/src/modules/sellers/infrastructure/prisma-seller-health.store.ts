import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  UNHEALTHY_QUEUE_MAX,
  type SellerHealthSnapshot,
  type SellerHealthStore,
  type SellerHealthSummary,
} from '../application/ports/seller-health.store';
import {
  SELLER_HEALTH_METRICS,
  bandOfScore,
  type MetricResult,
  type SellerHealth,
  type SellerHealthInput,
  type SellerHealthMetric,
} from '../domain/seller-health';
import type { SellerHealthDay } from '../domain/seller-health-days';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
/** A `DATE` column is read as the UTC midnight of that date (no zone arithmetic on a local date). */
const toDay = (date: Date): Temporal.PlainDate =>
  Temporal.PlainDate.from(date.toISOString().slice(0, 10));
const dayDate = (day: Temporal.PlainDate): Date => new Date(`${day.toString()}T00:00:00.000Z`);

/** A stored row that breaks the domain's rules: a fault of the data, never a value to use. */
/** The candidate read looks at most this many times the cap of sellers before it says `truncated`. */
const UNHEALTHY_CANDIDATE_FACTOR = 5;

export class StoredSellerHealthError extends Error {
  override readonly name = 'StoredSellerHealthError';
  constructor(column: string) {
    super(`sellers.seller_health_snapshots holds an invalid ${column}`);
  }
}

interface StoredMetrics {
  readonly inputs: SellerHealthInput;
  readonly results: readonly MetricResult[];
}

const isMetric = (value: unknown): value is SellerHealthMetric =>
  (SELLER_HEALTH_METRICS as readonly unknown[]).includes(value);

function metricsOf(value: unknown): StoredMetrics {
  if (typeof value !== 'object' || value === null) throw new StoredSellerHealthError('metrics');
  const { inputs, results } = value as { inputs?: unknown; results?: unknown };
  if (typeof inputs !== 'object' || inputs === null || !Array.isArray(results)) {
    throw new StoredSellerHealthError('metrics');
  }
  for (const result of results as { metric?: unknown }[]) {
    if (!isMetric(result.metric)) throw new StoredSellerHealthError('metrics');
  }
  return { inputs: inputs as SellerHealthInput, results: results as MetricResult[] };
}

export class PrismaSellerHealthStore implements SellerHealthStore {
  constructor(private readonly prisma: PrismaService) {}

  async saveDay(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    day: SellerHealthDay,
    recountedAt: Temporal.Instant,
  ): Promise<void> {
    const data = {
      paidOrders: day.paidOrders,
      readyOrders: day.readyOrders,
      lateReadyOrders: day.lateReadyOrders,
      lostDisputes: day.lostDisputes,
      reviewsApproved: day.reviewsApproved,
      ratingStarsSum: day.ratingStarsSum,
      recountedAt: toDate(recountedAt),
    };
    await this.prisma.tx(market).sellersSellerHealthDay.upsert({
      where: {
        marketId: market.marketId,
        marketId_sellerId_day: { marketId: market.marketId, sellerId, day: dayDate(day.day) },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId,
        day: dayDate(day.day),
        ...data,
      },
      update: data,
    });
  }

  async days(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly SellerHealthDay[]> {
    const rows = await this.prisma.tx(market).sellersSellerHealthDay.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        day: { gte: dayDate(from), lte: dayDate(to) },
      },
      orderBy: { day: 'asc' },
    });
    return rows.map((row) => ({
      day: toDay(row.day),
      paidOrders: row.paidOrders,
      readyOrders: row.readyOrders,
      lateReadyOrders: row.lateReadyOrders,
      lostDisputes: row.lostDisputes,
      reviewsApproved: row.reviewsApproved,
      ratingStarsSum: row.ratingStarsSum,
    }));
  }

  async saveSnapshot(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    snapshot: SellerHealthSnapshot,
  ): Promise<void> {
    const { health } = snapshot;
    const scored = health.kind === 'scored';
    const data = {
      kind: health.kind,
      band: scored ? health.band : null,
      score: scored ? health.score : null,
      lowestMetric: scored ? health.lowestMetric : null,
      formulaVersion: health.formulaVersion,
      metrics: {
        inputs: snapshot.inputs,
        results: health.metrics,
      } as unknown as Prisma.InputJsonValue,
      computedAt: toDate(snapshot.computedAt),
    };
    await this.prisma.tx(market).sellersSellerHealthSnapshot.upsert({
      where: {
        marketId: market.marketId,
        marketId_sellerId_day: {
          marketId: market.marketId,
          sellerId,
          day: dayDate(snapshot.day),
        },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId,
        day: dayDate(snapshot.day),
        ...data,
      },
      update: data,
    });
  }

  async snapshots(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly SellerHealthSnapshot[]> {
    const rows = await this.prisma.tx(market).sellersSellerHealthSnapshot.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        day: { gte: dayDate(from), lte: dayDate(to) },
      },
      orderBy: { day: 'asc' },
    });
    return rows.map((row) => {
      const { inputs, results } = metricsOf(row.metrics);
      let health: SellerHealth;
      if (row.kind === 'scored') {
        if (row.score === null || row.band === null || !isMetric(row.lowestMetric)) {
          throw new StoredSellerHealthError('score');
        }
        if (bandOfScore(row.score) !== row.band) throw new StoredSellerHealthError('band');
        health = {
          kind: 'scored',
          band: row.band,
          score: row.score,
          lowestMetric: row.lowestMetric,
          metrics: results,
          formulaVersion: row.formulaVersion,
        };
      } else if (row.kind === 'new' || row.kind === 'no-data') {
        health = { kind: row.kind, metrics: results, formulaVersion: row.formulaVersion };
      } else {
        throw new StoredSellerHealthError('kind');
      }
      return { day: toDay(row.day), health, inputs, computedAt: toInstant(row.computedAt) };
    });
  }

  async latest(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<ReadonlyMap<Id<'Seller'>, SellerHealthSummary>> {
    if (sellerIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).sellersSellerHealthSnapshot.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        day: { gte: dayDate(from), lte: dayDate(to) },
      },
      orderBy: [{ sellerId: 'asc' }, { day: 'desc' }],
      distinct: ['sellerId'],
      select: {
        sellerId: true,
        day: true,
        kind: true,
        band: true,
        score: true,
        lowestMetric: true,
      },
    });
    const found = new Map<Id<'Seller'>, SellerHealthSummary>();
    for (const row of rows) {
      if (row.kind !== 'scored' && row.kind !== 'new' && row.kind !== 'no-data') {
        throw new StoredSellerHealthError('kind');
      }
      if (row.kind === 'scored') {
        if (row.score === null || row.band === null || bandOfScore(row.score) !== row.band) {
          throw new StoredSellerHealthError('score');
        }
        if (!isMetric(row.lowestMetric)) throw new StoredSellerHealthError('score');
      }
      found.set(row.sellerId as Id<'Seller'>, {
        day: toDay(row.day),
        kind: row.kind,
        band: row.kind === 'scored' ? (row.band as 'healthy' | 'at-risk' | 'unhealthy') : null,
        score: row.kind === 'scored' ? row.score : null,
        lowestMetric: row.kind === 'scored' && isMetric(row.lowestMetric) ? row.lowestMetric : null,
      });
    }
    return found;
  }

  async unhealthy(
    market: MarketContext,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
    limit: number = UNHEALTHY_QUEUE_MAX,
  ): Promise<{
    readonly sellers: readonly (SellerHealthSummary & { readonly sellerId: Id<'Seller'> })[];
    readonly truncated: boolean;
  }> {
    // Sellers with an unhealthy snapshot in the range, then each one's newest snapshot: one that
    // has since recovered, or was measured again as healthy, drops out. The candidate read is
    // bounded (a grouped SELECT with a LIMIT, so the database stops early); when more candidates
    // exist than the bound, the answer is `truncated` even if some of them have recovered.
    const bound = limit * UNHEALTHY_CANDIDATE_FACTOR;
    const grouped = await this.prisma.tx(market).sellersSellerHealthSnapshot.groupBy({
      by: ['sellerId'],
      where: {
        marketId: market.marketId,
        band: 'unhealthy',
        day: { gte: dayDate(from), lte: dayDate(to) },
      },
      orderBy: { sellerId: 'asc' },
      take: bound + 1,
    });
    const overflow = grouped.length > bound;
    const ids = grouped.slice(0, bound).map((row) => row.sellerId as Id<'Seller'>);
    const latest = await this.latest(market, ids, from, to);
    const still = ids.flatMap((sellerId) => {
      const summary = latest.get(sellerId);
      if (summary === undefined || summary.band !== 'unhealthy') return [];
      if (summary.score === null) throw new StoredSellerHealthError('score');
      return [{ sellerId, ...summary, score: summary.score }];
    });
    still.sort((a, b) => a.score - b.score || (a.sellerId < b.sellerId ? -1 : 1));
    return {
      sellers: still.slice(0, limit),
      truncated: overflow || still.length > limit,
    };
  }

  async purgeBefore(
    market: MarketContext,
    before: Temporal.PlainDate,
  ): Promise<{ readonly days: number; readonly snapshots: number }> {
    const tx = this.prisma.tx(market);
    const where = { marketId: market.marketId, day: { lt: dayDate(before) } };
    const days = await tx.sellersSellerHealthDay.deleteMany({ where });
    const snapshots = await tx.sellersSellerHealthSnapshot.deleteMany({ where });
    return { days: days.count, snapshots: snapshots.count };
  }
}
