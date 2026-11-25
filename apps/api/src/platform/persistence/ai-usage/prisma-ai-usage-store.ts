import { Temporal } from '@mondapac/shared-kernel';
import type { IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import {
  counterKeyText,
  LATENCY_BUCKETS_MS,
  type AiUsageStore,
  type BudgetCounterKey,
  type BudgetLine,
  type CallRecord,
  type ReservationRecord,
  type UsageDelta,
} from '../../ai/usage/ai-usage-store';
import type { PrismaService } from '../prisma.service';

/** A calendar day as the DATE column takes it. */
const dateOf = (day: Temporal.PlainDate): Date => new Date(`${day.toString()}T00:00:00Z`);
const plainDateOf = (date: Date): Temporal.PlainDate =>
  Temporal.PlainDate.from(date.toISOString().slice(0, 10));
const instantOf = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const timestampOf = (at: Temporal.Instant): Date => new Date(at.epochMilliseconds);

/** The latency bucket column a call of `latencyMs` is counted in. */
const LATENCY_COLUMNS = [
  'latencyLe500Ms',
  'latencyLe1000Ms',
  'latencyLe2000Ms',
  'latencyLe4000Ms',
  'latencyLe8000Ms',
  'latencyLe16000Ms',
  'latencyLe32000Ms',
  'latencyGt32000Ms',
] as const;
export function latencyColumnOf(latencyMs: number): (typeof LATENCY_COLUMNS)[number] {
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => latencyMs <= bound);
  return LATENCY_COLUMNS[index === -1 ? LATENCY_COLUMNS.length - 1 : index]!;
}

/**
 * {@link AiUsageStore} on the four `platform.ai_*` tables (docs/design/domain/platform-ai.md
 * section 10; migration 20261125100000_platform_ai_usage). Every statement goes through
 * `tx(market)`, so the market guard pins it to the unit's Market and tenant. The cap check is a
 * conditional `updateMany` (one `UPDATE ... WHERE held <= cap - amount`), which PostgreSQL
 * re-checks on the latest row version after waiting for a concurrent writer, so two units can
 * never both pass a cap that has room for one. These tables are reserved to this folder
 * (scripts/check-prisma-boundaries.mjs, AI_USAGE_TABLES).
 */
export class PrismaAiUsageStore implements AiUsageStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async hold(
    market: MarketContext,
    lines: readonly BudgetLine[],
    amountMicroUsd: number,
  ): Promise<boolean> {
    if (lines.some((line) => line.capMicroUsd !== null && line.capMicroUsd < amountMicroUsd)) {
      return false;
    }
    const tx = this.prisma.tx(market);
    // The rows first, in the fixed order (most specific first, the Market's month last); an
    // existing row is left alone (ON CONFLICT DO NOTHING).
    await tx.aiBudgetCounter.createMany({
      data: lines.map((line) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        period: line.period,
        periodStart: dateOf(line.periodStart),
        scope: line.scope,
        scopeKey: line.scopeKey,
      })),
      skipDuplicates: true,
    });
    for (const line of lines) {
      const held = await tx.aiBudgetCounter.updateMany({
        where: {
          ...this.#whereOf(market, line),
          ...(line.capMicroUsd === null
            ? {}
            : { heldMicroUsd: { lte: BigInt(line.capMicroUsd - amountMicroUsd) } }),
        },
        data: { heldMicroUsd: { increment: BigInt(amountMicroUsd) } },
      });
      if (held.count !== 1) return false;
    }
    return true;
  }

  async adjust(
    market: MarketContext,
    keys: readonly BudgetCounterKey[],
    heldDelta: number,
    spent: number,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    for (const key of keys) {
      // A counter purged meanwhile is not recreated: there is nothing left to correct.
      await tx.aiBudgetCounter.updateMany({
        where: this.#whereOf(market, key),
        data: {
          heldMicroUsd: { increment: BigInt(heldDelta) },
          spentMicroUsd: { increment: BigInt(spent) },
        },
      });
    }
  }

  async heldOf(
    market: MarketContext,
    keys: readonly BudgetCounterKey[],
  ): Promise<ReadonlyMap<string, number>> {
    if (keys.length === 0) return new Map();
    const rows = await this.prisma.tx(market).aiBudgetCounter.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        OR: keys.map((key) => ({
          period: key.period,
          periodStart: dateOf(key.periodStart),
          scope: key.scope,
          scopeKey: key.scopeKey,
        })),
      },
      select: { period: true, periodStart: true, scope: true, scopeKey: true, heldMicroUsd: true },
    });
    return new Map(
      rows.map((row) => [
        counterKeyText({
          period: row.period as BudgetCounterKey['period'],
          periodStart: plainDateOf(row.periodStart),
          scope: row.scope as BudgetCounterKey['scope'],
          scopeKey: row.scopeKey,
        }),
        Number(row.heldMicroUsd),
      ]),
    );
  }

  async addReservation(market: MarketContext, reservation: ReservationRecord): Promise<void> {
    await this.prisma.tx(market).aiBudgetReservation.create({
      data: {
        id: reservation.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        day: dateOf(reservation.day),
        capability: reservation.capability,
        sellerId: reservation.sellerId,
        guest: reservation.guest,
        estimateMicroUsd: BigInt(reservation.estimateMicroUsd),
        createdAt: timestampOf(reservation.createdAt),
        expiresAt: timestampOf(reservation.expiresAt),
      },
    });
  }

  async takeReservation(market: MarketContext, id: string): Promise<ReservationRecord | null> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const row = await tx.aiBudgetReservation.findFirst({ where: { ...scope, id } });
    if (row === null) return null;
    // Of two concurrent takes, the second waits for the first and then deletes nothing.
    const deleted = await tx.aiBudgetReservation.deleteMany({ where: { ...scope, id } });
    if (deleted.count !== 1) return null;
    return {
      id: row.id,
      day: plainDateOf(row.day),
      capability: row.capability,
      sellerId: row.sellerId,
      guest: row.guest,
      estimateMicroUsd: Number(row.estimateMicroUsd),
      createdAt: instantOf(row.createdAt),
      expiresAt: instantOf(row.expiresAt),
    };
  }

  async expiredReservations(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await this.prisma.tx(market).aiBudgetReservation.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        expiresAt: { lt: timestampOf(before) },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async addCall(market: MarketContext, call: CallRecord): Promise<boolean> {
    const inserted = await this.prisma.tx(market).aiCall.createMany({
      data: [
        {
          id: call.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          occurredAt: timestampOf(call.occurredAt),
          day: dateOf(call.day),
          capability: call.capability,
          sellerId: call.sellerId,
          guest: call.guest,
          provider: call.provider,
          model: call.model,
          attempt: call.attempt,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          inputPicoUsd: BigInt(call.inputPicoUsd),
          outputPicoUsd: BigInt(call.outputPicoUsd),
          costMicroUsd: BigInt(call.costMicroUsd),
          latencyMs: call.latencyMs,
          outcome: call.outcome,
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }

  async addUsage(market: MarketContext, usage: UsageDelta): Promise<void> {
    const tx = this.prisma.tx(market);
    const key = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      day: dateOf(usage.day),
      capability: usage.capability,
      sellerId: usage.sellerId,
    };
    // The unique index is NULLS NOT DISTINCT, so a row without a seller is created once.
    await tx.aiUsageDay.createMany({
      data: [{ id: this.ids.next<'AiUsageDay'>(), ...key }],
      skipDuplicates: true,
    });
    await tx.aiUsageDay.updateMany({
      where: key,
      data: {
        calls: { increment: usage.calls },
        failures: { increment: usage.failures },
        refusals: { increment: usage.refusals },
        inputTokens: { increment: BigInt(usage.inputTokens) },
        outputTokens: { increment: BigInt(usage.outputTokens) },
        costMicroUsd: { increment: BigInt(usage.costMicroUsd) },
        ...(usage.latencyMs === null
          ? {}
          : { [latencyColumnOf(usage.latencyMs)]: { increment: 1 } }),
      },
    });
  }

  async purgeCalls(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const rows = await tx.aiCall.findMany({
      where: { ...scope, occurredAt: { lt: timestampOf(before) } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const deleted = await tx.aiCall.deleteMany({
      where: { ...scope, id: { in: rows.map((row) => row.id) } },
    });
    return deleted.count;
  }

  async purgeUsageDays(
    market: MarketContext,
    before: Temporal.PlainDate,
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const rows = await tx.aiUsageDay.findMany({
      where: { ...scope, day: { lt: dateOf(before) } },
      // The unique index's order, so a batch needs no sort (Mojtaba, PR 1348 finding 5).
      orderBy: [{ day: 'asc' }, { capability: 'asc' }, { sellerId: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const deleted = await tx.aiUsageDay.deleteMany({
      where: { ...scope, id: { in: rows.map((row) => row.id) } },
    });
    return deleted.count;
  }

  async purgeCounters(
    market: MarketContext,
    before: Temporal.PlainDate,
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const rows = await tx.aiBudgetCounter.findMany({
      where: { ...scope, periodStart: { lt: dateOf(before) } },
      orderBy: [{ periodStart: 'asc' }],
      take: limit,
      select: { period: true, periodStart: true, scope: true, scopeKey: true },
    });
    if (rows.length === 0) return 0;
    const deleted = await tx.aiBudgetCounter.deleteMany({
      where: {
        ...scope,
        OR: rows.map(({ period, periodStart, scope: kind, scopeKey }) => ({
          period,
          periodStart,
          scope: kind,
          scopeKey,
        })),
      },
    });
    return deleted.count;
  }

  #whereOf(market: MarketContext, key: BudgetCounterKey) {
    return {
      marketId: market.marketId,
      tenantId: market.tenantId,
      period: key.period,
      periodStart: dateOf(key.periodStart),
      scope: key.scope,
      scopeKey: key.scopeKey,
    };
  }
}
