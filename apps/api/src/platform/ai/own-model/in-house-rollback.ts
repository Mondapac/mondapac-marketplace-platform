import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import { CLOCK } from '../../clock/clock.module';
import { ID_GENERATOR } from '../../ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../unit-of-work/unit-of-work';
import type { CapabilityTask } from '../capability';
import { CapabilityRegistry } from '../capability-registry';
import type { AiInHouseControls } from '../gateway-controls';
import { AiRouter } from '../routing/ai-router';
import { AI_USAGE_STORE, type AiUsageStore, type ServedTotals } from '../usage/ai-usage-store';
import { rollbackLimitsInForce, type RollbackLimits } from './in-house-stage';

/** The window the rates are judged on: the served in-house calls of the last hour. */
export const ROLLBACK_WINDOW = Temporal.Duration.from({ minutes: 60 });
/** The most often one instance judges a Market's task type (after a served live call). */
export const ROLLBACK_JUDGE_EVERY = Temporal.Duration.from({ seconds: 30 });
/** How long one instance reuses a Market's read of its rollbacks. */
export const ROLLBACK_READ_FOR = Temporal.Duration.from({ seconds: 10 });

/** The provider of the in-house model's routes (ADR-0052 decision 6). */
const IN_HOUSE_PROVIDER = 'mondapac';

/** Why a live stage was rolled back. */
export type RollbackReason = 'errors' | 'guard';

/**
 * Whether the counts pass a limit (design section 8, "Auto rollback"), or null: judged only on at
 * least the minimum sample; the error rate first (calls that did not end `ok`), then the rate of
 * answers the capability's own check guard-rejected, each strictly above its limit in tenths of a
 * percent. The limits are taken in force (clamped into the server bounds).
 */
export function rollbackReason(
  totals: ServedTotals,
  stored: RollbackLimits,
): RollbackReason | null {
  const limits = rollbackLimitsInForce(stored);
  if (totals.calls < limits.minSample) return null;
  if (totals.failures * 1000 > limits.errorsPermille * totals.calls) return 'errors';
  if (totals.guardRejected * 1000 > limits.guardPermille * totals.calls) return 'guard';
  return null;
}

interface RollbackRead {
  readonly at: Temporal.Instant;
  readonly latest: Readonly<Partial<Record<string, Temporal.Instant>>>;
}

/**
 * The auto-rollback of the in-house model's live stages (AI Gateway G6d3; docs/design/domain/
 * platform-ai.md section 8, "Auto rollback"). After a call the in-house model was chosen to answer,
 * {@link judge} counts, at most every {@link ROLLBACK_JUDGE_EVERY} per Market and task type on this
 * instance and in the background, the task type's served (not shadow) in-house calls of the last
 * hour, since the task type's in-house settings last changed: on at least the minimum sample, an
 * error rate or a guard-rejection rate above its limit records a rollback
 * (`platform.ai_in_house_rollbacks`) and logs `ai.in-house.rolled-back` for the operators. Only
 * numbers are judged, never a model's text (R2: no model output feeds the rule).
 *
 * {@link heldOff} is the gateway's read before it routes a live call: a task type whose latest
 * rollback is later than its settings' last change is held off, so its calls go to the external
 * models (the stage is served as off) until an admin changes the task type's stage, model or share
 * (a raise needs the step-up, G6b). Read per Market at most every {@link ROLLBACK_READ_FOR}; this
 * instance's own rollback counts at once. A read that fails holds every task type off (fail
 * closed); a judge that fails records nothing and is tried again on a later call.
 */
@Injectable()
export class InHouseRollback implements BeforeApplicationShutdown {
  readonly #logger = new Logger('InHouseRollback');
  readonly #reads = new Map<string, RollbackRead>();
  readonly #judged = new Map<string, Temporal.Instant>();
  readonly #running = new Set<Promise<void>>();
  #closing = false;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(AI_USAGE_STORE) private readonly store: AiUsageStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly router: AiRouter,
    private readonly registry: CapabilityRegistry,
  ) {}

  /**
   * Whether the task type's live stage is held off by a rollback now. Throws when the rollbacks
   * cannot be read (the gateway then routes no live call).
   */
  async heldOff(
    market: MarketContext,
    task: CapabilityTask,
    inHouse: AiInHouseControls,
  ): Promise<boolean> {
    const latest = (await this.#read(market)).latest[task];
    if (latest === undefined) return false;
    const changedAt = inHouse.changedAt?.[task];
    return changedAt === undefined || Temporal.Instant.compare(latest, changedAt) >= 0;
  }

  /**
   * Judges the task type's live stage after a call the in-house model was chosen to answer (see
   * the class); never awaited by the caller, never throws.
   */
  judge(
    market: MarketContext,
    task: CapabilityTask,
    stage: 'percent' | 'default',
    family: string,
    inHouse: AiInHouseControls,
  ): void {
    if (this.#closing) return;
    const key = `${market.marketId}|${task}`;
    const now = this.clock.now();
    const last = this.#judged.get(key);
    if (last !== undefined && Temporal.Instant.compare(now, last.add(ROLLBACK_JUDGE_EVERY)) < 0) {
      return;
    }
    this.#judged.set(key, now);
    const running: Promise<void> = this.#judge(market, task, stage, family, inHouse, now)
      .catch(() => {
        this.#logger.warn({ msg: 'ai.in-house.judge-failed', marketId: market.marketId, task });
      })
      .finally(() => {
        this.#running.delete(running);
      });
    this.#running.add(running);
  }

  async #judge(
    market: MarketContext,
    task: CapabilityTask,
    stage: 'percent' | 'default',
    family: string,
    inHouse: AiInHouseControls,
    now: Temporal.Instant,
  ): Promise<void> {
    if (await this.heldOff(market, task, inHouse)) return;
    const models = this.router.inHouseModelsOf(family);
    const capabilities = this.registry.ids().filter((id) => this.registry.get(id)?.task === task);
    let since = now.subtract(ROLLBACK_WINDOW);
    const changedAt = inHouse.changedAt?.[task];
    // A change of the settings starts a fresh count: calls before it belong to another stage.
    if (changedAt !== undefined && Temporal.Instant.compare(changedAt, since) > 0)
      since = changedAt;
    const read = await this.unitOfWork.run(
      market,
      async () =>
        ok(await this.store.servedTotals(market, IN_HOUSE_PROVIDER, models, capabilities, since)),
      { readOnly: true },
    );
    if (!read.ok) return;
    const totals = read.value;
    const reason = rollbackReason(totals, inHouse.rollback);
    if (reason === null) return;
    const limits = rollbackLimitsInForce(inHouse.rollback);
    const rolledBackAt = this.clock.now();
    const written = await this.unitOfWork.run(market, async () => {
      await this.store.addInHouseRollback(market, {
        id: this.ids.next(),
        task,
        family,
        stage,
        reason,
        calls: totals.calls,
        failures: totals.failures,
        guardRejected: totals.guardRejected,
        errorsLimitPermille: limits.errorsPermille,
        guardLimitPermille: limits.guardPermille,
        minSample: limits.minSample,
        rolledBackAt,
      });
      return ok(undefined);
    });
    if (!written.ok) return;
    // This instance holds the stage off at once; the others within ROLLBACK_READ_FOR.
    const cached = this.#reads.get(market.marketId);
    this.#reads.set(market.marketId, {
      at: cached?.at ?? rolledBackAt,
      latest: { ...(cached?.latest ?? {}), [task]: rolledBackAt },
    });
    this.#logger.warn({
      msg: 'ai.in-house.rolled-back',
      marketId: market.marketId,
      task,
      family,
      stage,
      reason,
      calls: totals.calls,
      failures: totals.failures,
      guardRejected: totals.guardRejected,
    });
  }

  async #read(market: MarketContext): Promise<RollbackRead> {
    const now = this.clock.now();
    const cached = this.#reads.get(market.marketId);
    if (
      cached !== undefined &&
      Temporal.Instant.compare(now, cached.at.add(ROLLBACK_READ_FOR)) < 0
    ) {
      return cached;
    }
    const read = await this.unitOfWork.run(
      market,
      async () => ok(await this.store.latestInHouseRollbacks(market)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('the in-house rollbacks could not be read');
    const fresh = { at: now, latest: read.value };
    this.#reads.set(market.marketId, fresh);
    return fresh;
  }

  /** Waits for every judge started so far (tests, and shutdown). */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }

  /** On close no new judge starts, and the ones out end before the database pool closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.#closing = true;
    await this.settled();
  }
}
