import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../market-config/market-registry';
import type { UnitOfWork } from '../../unit-of-work/unit-of-work';
import {
  counterKeyText,
  LATENCY_BUCKETS_MS,
  type AiUsageStore,
  type BudgetCounterKey,
  type BudgetLine,
  type CallOutcome,
  type ReservationRecord,
} from './ai-usage-store';

export { LATENCY_BUCKETS_MS };

/** Who a call is counted for: its capability, its seller (seller-scoped) and the guest pool. */
export interface UsageScope {
  readonly capability: string;
  readonly sellerId: string | null;
  /** A buyer capability called by an anonymous visitor. */
  readonly guest: boolean;
}

/** A held reservation, settled once with {@link AiUsage.settle}. */
export interface Reservation {
  readonly id: string;
  readonly day: Temporal.PlainDate;
  readonly scope: UsageScope;
  readonly estimateMicroUsd: number;
}

/** What a sent call cost and how it went, for its usage row. */
export interface SettledCall {
  readonly occurredAt: Temporal.Instant;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputPicoUsd: number;
  readonly outputPicoUsd: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly outcome: CallOutcome;
}

/** The Market's caps (Market configuration `aiBudget`, until G4); absent is not capped. */
interface Caps {
  readonly marketDay: number | null;
  readonly marketMonth: number | null;
  readonly capabilityDay: number | null;
  readonly sellerDay: number | null;
  readonly guestDay: number | null;
}

/** Calls are kept 90 days (design section 10); in hours, as an Instant has no calendar. */
export const AI_CALLS_KEPT = Temporal.Duration.from({ hours: 90 * 24 });
/** Day rows and counters are kept 25 months (design section 10). */
export const AI_USAGE_DAYS_KEPT = Temporal.Duration.from({ months: 25 });
/** A reservation outlives its call's timeout by this before the sweeper may release it. */
export const RESERVATION_GRACE = Temporal.Duration.from({ seconds: 60 });

/** Rows per unit and units per run, so a job run stays bounded (P 7). */
export const USAGE_BATCH = 500;
export const USAGE_MAX_BATCHES = 40;
/**
 * How long a reserve or settle unit waits for a counter row's lock: a stalled hot row fails
 * closed quickly (off) instead of queueing to the role's 3 s (Mojtaba finding 1, Hassan L3).
 */
export const USAGE_LOCK_TIMEOUT_MS = 1000;
/** Settle attempts before the failure is logged and the sweeper counts the estimate (Hassan M2). */
export const SETTLE_ATTEMPTS = 3;

const logger = new Logger('AiUsage');

/**
 * The AI Gateway's budget and usage record (docs/design/domain/platform-ai.md sections 7 and 10).
 * Before a call the gateway reserves the most the call can cost on every counter of its scope, in
 * one short read-write unit outside the caller's work (the gateway is never called inside a
 * unit); after it, one unit settles the reservation once with the real cost and writes the call's
 * row and its day totals. Since G7 this is also the buyer assistant's spend (read through
 * `AiUsageReport`); `assistant.spend_days` is no longer written.
 */
export class AiUsage {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AiUsageStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly markets: MarketRegistry,
  ) {}

  /** The Market day (in the Market's time zone) of an instant. */
  dayOf(market: MarketContext, at: Temporal.Instant): Temporal.PlainDate {
    return at.toZonedDateTimeISO(this.markets.get(market.marketId).timezone).toPlainDate();
  }

  /**
   * The counters of a scope on a day, in the one fixed order every unit takes them, most specific
   * first: the seller's day or the guest pool's day, the capability's day, the Market's day, then
   * the Market's month. The Market rows every call shares are locked last, so they are held for
   * the shortest time before the commit (Mojtaba, PR 1348 finding 1).
   */
  linesOf(market: MarketContext, scope: UsageScope, day: Temporal.PlainDate): BudgetLine[] {
    const caps = this.#caps(market);
    const lines: BudgetLine[] = [];
    if (scope.sellerId !== null) {
      lines.push({
        period: 'day',
        periodStart: day,
        scope: 'seller',
        scopeKey: scope.sellerId,
        capMicroUsd: caps.sellerDay,
      });
    }
    if (scope.guest) {
      lines.push({
        period: 'day',
        periodStart: day,
        scope: 'guest',
        scopeKey: '',
        capMicroUsd: caps.guestDay,
      });
    }
    lines.push(
      {
        period: 'day',
        periodStart: day,
        scope: 'capability',
        scopeKey: scope.capability,
        capMicroUsd: caps.capabilityDay,
      },
      {
        period: 'day',
        periodStart: day,
        scope: 'market',
        scopeKey: '',
        capMicroUsd: caps.marketDay,
      },
      {
        period: 'month',
        periodStart: day.with({ day: 1 }),
        scope: 'market',
        scopeKey: '',
        capMicroUsd: caps.marketMonth,
      },
    );
    return lines;
  }

  /**
   * Whether a cap of the scope is full today: it cannot take `roomMicroUsd` more (for `status`, the
   * most one call of the capability can cost; for `run`, the call's estimate, read before any row
   * is locked so a refused call never queues on the Market's rows; Hassan, PR 1348 M1). Absent,
   * a cap is full when nothing is left. Always opens its read-only unit
   * (no transaction, ADR-0025), even when the Market caps none of the scope's counters, so a
   * caller inside an open unit is refused in every Market (`NestedUnitOfWorkError`) and not only
   * once caps are set. Throws on a store failure; the gateway treats that as off.
   */
  async overBudget(market: MarketContext, scope: UsageScope, roomMicroUsd = 0): Promise<boolean> {
    const capped = this.linesOf(market, scope, this.dayOf(market, this.clock.now())).filter(
      (line) => line.capMicroUsd !== null,
    );
    const held = await this.unitOfWork.run(
      market,
      async () => ok(await this.store.heldOf(market, capped)),
      { readOnly: true },
    );
    if (!held.ok) return true;
    const room = Math.max(1, roomMicroUsd);
    return capped.some(
      (line) => line.capMicroUsd! - (held.value.get(counterKeyText(line)) ?? 0) < room,
    );
  }

  /**
   * Holds `estimateMicroUsd` on every counter of the scope, all or nothing, and records the
   * reservation with its expiry (`ttl` after now). Answers 'over-budget' when a cap is full.
   * Throws on a store failure; the gateway then calls nothing.
   */
  async reserve(
    market: MarketContext,
    scope: UsageScope,
    estimateMicroUsd: number,
    ttl: Temporal.Duration,
  ): Promise<Reservation | 'over-budget'> {
    const now = this.clock.now();
    const day = this.dayOf(market, now);
    const id = this.ids.next<'AiCall'>();
    const lines = this.linesOf(market, scope, day);
    // The reservation's row first and the counters last, so the commit follows the last counter
    // UPDATE directly; a refusal rolls both back (Mojtaba, PR 1348 finding 1).
    const held = await this.unitOfWork.run<Reservation, 'over-budget'>(
      market,
      async () => {
        await this.store.addReservation(market, {
          id,
          day,
          capability: scope.capability,
          sellerId: scope.sellerId,
          guest: scope.guest,
          estimateMicroUsd,
          createdAt: now,
          expiresAt: now.add(ttl),
        });
        if (!(await this.store.hold(market, lines, estimateMicroUsd))) return err('over-budget');
        return ok({ id, day, scope, estimateMicroUsd });
      },
      { lockTimeoutMs: USAGE_LOCK_TIMEOUT_MS },
    );
    return held.ok ? held.value : held.error;
  }

  /**
   * Settles a reservation once: the reservation is deleted and each counter's `held` is corrected
   * to the real cost, which is added to `spent`. `call` null means nothing was sent: the estimate
   * is released. When the sweeper took the reservation already, it counted the estimate as spent,
   * so the call's row and its day totals are written and the counters are left as they are (the
   * estimate is the most the call is taken to cost); when the call's row exists already (settled before),
   * nothing changes. The call's row and its day totals are written in the same unit. Tried
   * {@link SETTLE_ATTEMPTS} times; never throws: a settle that still fails is logged as an error
   * (`ai.usage.settle-failed`), and the sweeper later counts the whole estimate as spent, so a
   * failure over-counts and never under-counts (Hassan, PR 1348 M2).
   */
  async settle(
    market: MarketContext,
    reservation: Reservation,
    call: SettledCall | null,
  ): Promise<void> {
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
      try {
        await this.#settleOnce(market, reservation, call);
        return;
      } catch {
        // Retried: a lock wait or a unit timeout on a hot row is usually gone a moment later.
      }
    }
    logger.error({
      msg: 'ai.usage.settle-failed',
      marketId: market.marketId,
      ...scopeLog(reservation.scope),
    });
  }

  async #settleOnce(
    market: MarketContext,
    reservation: Reservation,
    call: SettledCall | null,
  ): Promise<void> {
    const { scope, day } = reservation;
    const cost = call?.costMicroUsd ?? 0;
    const settled = await this.unitOfWork.run(
      market,
      async () => {
        const taken = await this.store.takeReservation(market, reservation.id);
        if (call !== null) {
          const first = await this.store.addCall(market, {
            id: reservation.id,
            day,
            capability: scope.capability,
            sellerId: scope.sellerId,
            guest: scope.guest,
            ...call,
          });
          // The call's row is there already: this call was settled before, nothing more to count.
          if (!first) return ok(null);
          await this.store.addUsage(market, {
            day,
            capability: scope.capability,
            sellerId: scope.sellerId,
            calls: 1,
            failures: call.outcome === 'ok' ? 0 : 1,
            refusals: 0,
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
            costMicroUsd: cost,
            latencyMs: call.latencyMs,
          });
        }
        // Swept already: the estimate was counted as spent, and it covers the cost.
        if (taken === null) return ok(null);
        const heldDelta = cost - taken.estimateMicroUsd;
        if (heldDelta !== 0 || cost !== 0) {
          await this.store.adjust(market, this.linesOf(market, scope, day), heldDelta, cost);
        }
        return ok(null);
      },
      { lockTimeoutMs: USAGE_LOCK_TIMEOUT_MS },
    );
    if (!settled.ok) throw new Error('not settled');
  }

  /** Counts a run refused before any call (a full cap, too large an input, too many rounds). */
  async refused(market: MarketContext, scope: UsageScope): Promise<void> {
    try {
      await this.unitOfWork.run(market, async () => {
        await this.store.addUsage(market, {
          day: this.dayOf(market, this.clock.now()),
          capability: scope.capability,
          sellerId: scope.sellerId,
          calls: 0,
          failures: 0,
          refusals: 1,
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0,
          latencyMs: null,
        });
        return ok(null);
      });
    } catch {
      logger.warn({ msg: 'ai.usage.count-failed', marketId: market.marketId, ...scopeLog(scope) });
    }
  }

  /**
   * Ends reservations a server never settled (it died, or the settle failed): each expired one
   * is taken and its whole estimate counted as spent (`held` keeps it), one unit each, so a run
   * racing a late settle counts nothing twice. The call may have been sent and billed, so an
   * unsettled call over-counts and never under-counts (Hassan, PR 1348 M2); a late settle then
   * writes the call's row and leaves the counters. Stops after `runForMs` (the job's run time,
   * Hassan L4). Answers how many it ended and whether some are left.
   */
  async sweep(
    market: MarketContext,
    runForMs?: number,
  ): Promise<{ released: number; backlog: boolean }> {
    let released = 0;
    const deadline = this.#deadlineOf(runForMs);
    const late = () =>
      deadline !== undefined && Temporal.Instant.compare(this.clock.now(), deadline) >= 0;
    for (let batch = 0; batch < USAGE_MAX_BATCHES; batch += 1) {
      if (late()) return { released, backlog: true };
      const ids = await this.unitOfWork.run(
        market,
        async () => ok(await this.store.expiredReservations(market, this.clock.now(), USAGE_BATCH)),
        { readOnly: true },
      );
      if (!ids.ok) return { released, backlog: false };
      for (const id of ids.value) {
        if (late()) return { released, backlog: true };
        const done = await this.unitOfWork.run(
          market,
          async () => {
            const taken = await this.store.takeReservation(market, id);
            if (taken === null) return ok(false);
            await this.store.adjust(
              market,
              this.linesOf(market, scopeOf(taken), taken.day),
              0,
              taken.estimateMicroUsd,
            );
            return ok(true);
          },
          { lockTimeoutMs: USAGE_LOCK_TIMEOUT_MS },
        );
        if (done.ok && done.value) released += 1;
      }
      if (ids.value.length < USAGE_BATCH) return { released, backlog: false };
    }
    return { released, backlog: true };
  }

  /**
   * The retention of the usage tables (design section 10): calls older than 90 days, day rows and
   * counters older than 25 months, in batches of one unit each, stopping after `runForMs`.
   */
  async purge(
    market: MarketContext,
    runForMs?: number,
  ): Promise<{ calls: number; days: number; counters: number; backlog: boolean }> {
    const now = this.clock.now();
    const deadline = this.#deadlineOf(runForMs);
    const callsBefore = now.subtract(AI_CALLS_KEPT);
    const daysBefore = this.dayOf(market, now).subtract(AI_USAGE_DAYS_KEPT);
    const calls = await this.#batches(market, deadline, () =>
      this.store.purgeCalls(market, callsBefore, USAGE_BATCH),
    );
    const days = await this.#batches(market, deadline, () =>
      this.store.purgeUsageDays(market, daysBefore, USAGE_BATCH),
    );
    const counters = await this.#batches(market, deadline, () =>
      this.store.purgeCounters(market, daysBefore, USAGE_BATCH),
    );
    return {
      calls: calls.total,
      days: days.total,
      counters: counters.total,
      backlog: calls.backlog || days.backlog || counters.backlog,
    };
  }

  async #batches(
    market: MarketContext,
    deadline: Temporal.Instant | undefined,
    batch: () => Promise<number>,
  ): Promise<{ total: number; backlog: boolean }> {
    let total = 0;
    for (let index = 0; index < USAGE_MAX_BATCHES; index += 1) {
      if (deadline !== undefined && Temporal.Instant.compare(this.clock.now(), deadline) >= 0) {
        return { total, backlog: true };
      }
      const result = await this.unitOfWork.run(market, async () => ok(await batch()));
      if (!result.ok) return { total, backlog: false };
      total += result.value;
      if (result.value < USAGE_BATCH) return { total, backlog: false };
    }
    return { total, backlog: true };
  }

  #deadlineOf(runForMs: number | undefined): Temporal.Instant | undefined {
    return runForMs === undefined
      ? undefined
      : this.clock.now().add(Temporal.Duration.from({ milliseconds: runForMs }));
  }

  #caps(market: MarketContext): Caps {
    const budget = this.markets.get(market.marketId).aiBudget;
    return {
      marketDay: budget?.marketDayMicroUsd ?? null,
      marketMonth: budget?.marketMonthMicroUsd ?? null,
      capabilityDay: budget?.capabilityDayMicroUsd ?? null,
      sellerDay: budget?.sellerDayMicroUsd ?? null,
      guestDay: budget?.guestDayMicroUsd ?? null,
    };
  }
}

const scopeOf = (reservation: ReservationRecord): UsageScope => ({
  capability: reservation.capability,
  sellerId: reservation.sellerId,
  guest: reservation.guest,
});

/** What a log line may say about a scope: the capability and whether it is a guest's. */
const scopeLog = (scope: UsageScope) => ({ capability: scope.capability, guest: scope.guest });

export type { BudgetCounterKey };
