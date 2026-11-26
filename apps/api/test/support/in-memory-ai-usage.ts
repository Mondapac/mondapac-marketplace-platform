import { randomBytes } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext, Result } from '@mondapac/shared-kernel';
import { AiUsage } from '../../src/platform/ai/usage/ai-usage';
import {
  counterKeyText,
  type AiUsageStore,
  type BudgetCounterKey,
  type BudgetLine,
  type BudgetPeriod,
  type CallRecord,
  type CapabilityTokenTotals,
  type CapReached,
  type DayCost,
  LATENCY_BUCKETS_MS,
  type ModelCallTotals,
  type ReservationRecord,
  type UsageDelta,
} from '../../src/platform/ai/usage/ai-usage-store';
import type { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { NestedUnitOfWorkError } from '../../src/platform/unit-of-work/errors';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';

interface Counter {
  held: number;
  spent: number;
}

/**
 * {@link AiUsageStore} in memory, per Market, for unit tests of the AI Gateway and its callers. A
 * read-write unit of {@link InMemoryAiUsageUnitOfWork} that ends with `err` or throws restores the
 * state it started with, as a rolled-back transaction would.
 */
export class InMemoryAiUsageStore implements AiUsageStore {
  counters = new Map<string, Counter>();
  reservations = new Map<string, ReservationRecord>();
  calls: CallRecord[] = [];
  usage: UsageDelta[] = [];
  /** "Cap reached" records by Market, capability and day. */
  capReached = new Map<string, CapReached>();
  /** Set to make every method throw (the database is down). */
  failing = false;
  /** The next this many calls throw, then the store works again (a lock wait that passes). */
  failNext = 0;

  #key(market: MarketContext, key: BudgetCounterKey) {
    return `${market.marketId}|${counterKeyText(key)}`;
  }

  #check() {
    if (this.failing) throw new Error('store down');
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('lock timeout');
    }
  }

  snapshot() {
    return {
      counters: new Map([...this.counters].map(([key, value]) => [key, { ...value }])),
      reservations: new Map(this.reservations),
      calls: [...this.calls],
      usage: [...this.usage],
      capReached: new Map(this.capReached),
    };
  }

  restore(state: ReturnType<InMemoryAiUsageStore['snapshot']>) {
    this.counters = state.counters;
    this.reservations = state.reservations;
    this.calls = state.calls;
    this.usage = state.usage;
    this.capReached = state.capReached;
  }

  /** The counter's held and spent, or undefined. */
  counterOf(market: MarketContext, key: BudgetCounterKey): Counter | undefined {
    return this.counters.get(this.#key(market, key));
  }

  hold(market: MarketContext, lines: readonly BudgetLine[], amount: number): Promise<boolean> {
    this.#check();
    for (const line of lines) {
      const key = this.#key(market, line);
      const counter = this.counters.get(key) ?? { held: 0, spent: 0 };
      this.counters.set(key, counter);
      if (line.capMicroUsd !== null && counter.held + amount > line.capMicroUsd) {
        return Promise.resolve(false);
      }
      counter.held += amount;
    }
    return Promise.resolve(true);
  }

  adjust(
    market: MarketContext,
    keys: readonly BudgetCounterKey[],
    heldDelta: number,
    spent: number,
  ): Promise<void> {
    this.#check();
    for (const key of keys) {
      const counter = this.counters.get(this.#key(market, key));
      if (counter === undefined) continue;
      counter.held += heldDelta;
      counter.spent += spent;
    }
    return Promise.resolve();
  }

  heldOf(
    market: MarketContext,
    keys: readonly BudgetCounterKey[],
  ): Promise<ReadonlyMap<string, number>> {
    this.#check();
    const held = new Map<string, number>();
    for (const key of keys) {
      const counter = this.counters.get(this.#key(market, key));
      if (counter !== undefined) held.set(counterKeyText(key), counter.held);
    }
    return Promise.resolve(held);
  }

  addReservation(market: MarketContext, reservation: ReservationRecord): Promise<void> {
    this.#check();
    this.reservations.set(`${market.marketId}|${reservation.id}`, reservation);
    return Promise.resolve();
  }

  takeReservation(market: MarketContext, id: string): Promise<ReservationRecord | null> {
    this.#check();
    const key = `${market.marketId}|${id}`;
    const reservation = this.reservations.get(key) ?? null;
    this.reservations.delete(key);
    return Promise.resolve(reservation);
  }

  expiredReservations(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly string[]> {
    this.#check();
    return Promise.resolve(
      [...this.reservations]
        .filter(
          ([key, reservation]) =>
            key.startsWith(`${market.marketId}|`) &&
            reservation.expiresAt.epochMilliseconds < before.epochMilliseconds,
        )
        .slice(0, limit)
        .map(([, reservation]) => reservation.id),
    );
  }

  addCall(_market: MarketContext, call: CallRecord): Promise<boolean> {
    this.#check();
    if (this.calls.some((existing) => existing.id === call.id)) return Promise.resolve(false);
    this.calls.push(call);
    return Promise.resolve(true);
  }

  addUsage(_market: MarketContext, usage: UsageDelta): Promise<void> {
    this.#check();
    this.usage.push(usage);
    return Promise.resolve();
  }

  costByDay(
    market: MarketContext,
    capability: string,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly DayCost[]> {
    this.#check();
    const days: DayCost[] = [];
    for (const [key, counter] of this.counters) {
      const [marketId, period, start, scope, scopeKey] = key.split('|');
      if (marketId !== market.marketId || period !== 'day' || scope !== 'capability') continue;
      if (scopeKey !== capability) continue;
      const day = Temporal.PlainDate.from(start!);
      if (Temporal.PlainDate.compare(day, from) < 0) continue;
      if (Temporal.PlainDate.compare(day, to) > 0) continue;
      days.push({ day, costMicroUsd: counter.spent });
    }
    return Promise.resolve(days.sort((a, b) => Temporal.PlainDate.compare(a.day, b.day)));
  }

  markCapReached(
    market: MarketContext,
    capability: string,
    day: Temporal.PlainDate,
    period: BudgetPeriod,
    at: Temporal.Instant,
  ): Promise<boolean> {
    this.#check();
    const key = `${market.marketId}|${capability}|${day.toString()}`;
    if (this.capReached.has(key)) return Promise.resolve(false);
    this.capReached.set(key, { at, period });
    return Promise.resolve(true);
  }

  lastCapReached(market: MarketContext, capability: string): Promise<CapReached | null> {
    this.#check();
    let last: CapReached | null = null;
    for (const [key, record] of this.capReached) {
      if (!key.startsWith(`${market.marketId}|${capability}|`)) continue;
      if (last === null || Temporal.Instant.compare(record.at, last.at) > 0) last = record;
    }
    return Promise.resolve(last);
  }

  /** Calls and day rows are kept without their Market here, as `addCall` and `addUsage` do. */
  callTotalsByModel(
    _market: MarketContext,
    since: Temporal.Instant,
    until: Temporal.Instant,
    leaveOut: string,
  ): Promise<readonly ModelCallTotals[]> {
    this.#check();
    const totals = new Map<string, ModelCallTotals & { atMostMs: number[] }>();
    for (const call of this.calls) {
      if (call.capability === leaveOut) continue;
      if (Temporal.Instant.compare(call.occurredAt, since) < 0) continue;
      if (Temporal.Instant.compare(call.occurredAt, until) >= 0) continue;
      const key = `${call.provider}|${call.model}`;
      const total = totals.get(key) ?? {
        provider: call.provider,
        model: call.model,
        calls: 0,
        failures: 0,
        laterAttempts: 0,
        costMicroUsd: 0,
        atMostMs: LATENCY_BUCKETS_MS.map(() => 0),
      };
      totals.set(key, {
        ...total,
        calls: total.calls + 1,
        failures: total.failures + (call.outcome === 'ok' ? 0 : 1),
        laterAttempts: total.laterAttempts + (call.attempt > 1 ? 1 : 0),
        costMicroUsd: total.costMicroUsd + call.costMicroUsd,
        atMostMs: total.atMostMs.map(
          (count, index) => count + (call.latencyMs <= LATENCY_BUCKETS_MS[index]! ? 1 : 0),
        ),
      });
    }
    return Promise.resolve([...totals.values()]);
  }

  tokenTotalsByCapability(
    _market: MarketContext,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
    leaveOut: string,
  ): Promise<readonly CapabilityTokenTotals[]> {
    this.#check();
    const totals = new Map<string, CapabilityTokenTotals>();
    for (const row of this.usage) {
      if (row.capability === leaveOut) continue;
      if (Temporal.PlainDate.compare(row.day, from) < 0) continue;
      if (Temporal.PlainDate.compare(row.day, to) > 0) continue;
      const total = totals.get(row.capability) ?? {
        capability: row.capability,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      totals.set(row.capability, {
        capability: row.capability,
        calls: total.calls + row.calls,
        inputTokens: total.inputTokens + row.inputTokens,
        outputTokens: total.outputTokens + row.outputTokens,
      });
    }
    return Promise.resolve([...totals.values()]);
  }

  purgeCalls(): Promise<number> {
    return Promise.resolve(0);
  }

  purgeUsageDays(): Promise<number> {
    return Promise.resolve(0);
  }

  purgeCounters(): Promise<number> {
    return Promise.resolve(0);
  }
}

/** A unit of work over the in-memory store: `err` or a throw restores the store; nesting throws. */
export class InMemoryAiUsageUnitOfWork implements UnitOfWork {
  #open = false;

  constructor(private readonly store: InMemoryAiUsageStore) {}

  async run<T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) {
    if (this.#open) throw new NestedUnitOfWorkError();
    this.#open = true;
    const before = this.store.snapshot();
    try {
      const result = await work();
      if (!result.ok) this.store.restore(before);
      return result;
    } catch (error) {
      this.store.restore(before);
      throw error;
    } finally {
      this.#open = false;
    }
  }

  runOnce(): never {
    throw new Error('not used');
  }
}

const testIds: IdGenerator = {
  next: <K extends string>() => uuidV7(Date.now(), randomBytes(10)) as Id<K>,
};

/** An {@link AiUsage} on an in-memory store, for unit tests. */
export function inMemoryAiUsage(markets: MarketRegistry, clock: Clock) {
  const store = new InMemoryAiUsageStore();
  const unitOfWork = new InMemoryAiUsageUnitOfWork(store);
  return { store, unitOfWork, usage: new AiUsage(unitOfWork, store, clock, testIds, markets) };
}
