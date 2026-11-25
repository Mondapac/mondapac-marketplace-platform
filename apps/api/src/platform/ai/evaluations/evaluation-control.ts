import { Inject, Injectable } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import { CLOCK } from '../../clock/clock.module';
import { ID_GENERATOR } from '../../ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../unit-of-work/unit-of-work';
import { AI_GATEWAY_CONTROLS, type AiGatewayControls } from '../gateway-controls';
import type { RouteProblem } from '../routing/ai-router';
import { AiUsage } from '../usage/ai-usage';
import { AiEvaluationGateway, closedBySaverThreshold } from './evaluation-gateway';
import {
  AI_EVALUATION_STORE,
  type AiEvaluationStore,
  type EvaluationCapabilityRecord,
  type EvaluationClosedStatus,
  type EvaluationRunRecord,
  type EvaluationSampleOutcome,
  type EvaluationSampleRecord,
} from './evaluation-store';
import { EvaluationSuiteRegistry, SAMPLE_ID, type EvaluationCheck } from './evaluation-suite';

/** Playground runs one admin may start per Market day (design section 8, Playground). */
export const AI_PLAYGROUND_RUNS_PER_ADMIN_DAY = 20;
/** Runs per page of the run list. */
export const EVALUATION_RUNS_PAGE = 20;

/**
 * Why a model cannot be evaluated now: a route problem other than `not-evaluated` (the catalogue,
 * Hassan's check, the region, the key, retirement, an unsupported task), no capability with a
 * suite, an open run of the model, or evaluations closed by the close rule.
 */
export type EvaluationBlocker =
  Exclude<RouteProblem, 'not-evaluated'> | 'no-suite' | 'run-open' | 'saver-closed';

export interface CapabilityEstimate {
  readonly capability: string;
  readonly promptVersion: string;
  readonly setVersion: string;
  readonly samples: number;
  /** The sum of each sample's reservation on the model's routes, US micro-dollars. */
  readonly estimateMicroUsd: number;
}

export interface EvaluationEstimate {
  readonly provider: string;
  readonly family: string;
  /** Every capability with a suite that the model can serve in the Market. */
  readonly capabilities: readonly CapabilityEstimate[];
  readonly estimateMicroUsd: number;
  /** What is left of the evaluation budget this Market month. */
  readonly budgetLeftMicroUsd: number;
  readonly blockers: readonly EvaluationBlocker[];
}

export interface EvaluationRunDetail {
  readonly run: EvaluationRunRecord;
  readonly capabilities: readonly EvaluationCapabilityRecord[];
  readonly samples: readonly EvaluationSampleRecord[];
  readonly costMicroUsd: number;
}

export interface EvaluationRunList {
  readonly runs: readonly EvaluationRunRecord[];
  /** The cursor of the next page, or null on the last one. */
  readonly next: string | null;
}

export interface PlaygroundSuite {
  readonly capability: string;
  readonly setVersion: string;
  readonly samples: readonly { readonly id: string; readonly label: string }[];
}

/** One model's side of a playground run: plain text after the capability's guard, never HTML. */
export interface PlaygroundAnswer {
  readonly family: string;
  readonly outcome: EvaluationSampleOutcome | EvaluationClosedStatus | 'refused';
  readonly text: string | null;
  readonly checks: readonly EvaluationCheck[];
  readonly costMicroUsd: number;
  readonly latencyMs: number | null;
  /** The catalogue row's route kind that answered, or null. */
  readonly route: string | null;
}

export type PlaygroundResult =
  | { readonly kind: 'invalid'; readonly path: string; readonly code: string }
  | { readonly kind: 'limit-reached' }
  | { readonly kind: 'ran'; readonly answers: readonly PlaygroundAnswer[] };

const CURSOR = /^(\d{1,16})\.([0-9a-f-]{36})$/;
const FAMILY = /^[a-z0-9][a-z0-9.-]{0,19}$/;

/**
 * `platform/ai`'s port for the evaluation runs and the playground (AI Gateway G4c; docs/design/
 * domain/platform-ai.md section 8, Tab 1, Evaluation and Playground), for `settings`, which owns
 * the admin API, its permissions, its step-up and its audit (ADR-0042). Like {@link AiModelChoices}
 * it is imported only by settings' module file and its evaluation and playground use cases
 * (boundary rule), which check the caller's access first; this file calls no model itself (the
 * evaluation gateway does, imported only inside `evaluations/`).
 *
 * Every read answers for the caller's Market only. `enqueue` runs in the caller's unit (with the
 * step-up spend and the audit row); every other method opens its own units and is never called
 * inside one.
 */
@Injectable()
export class AiEvaluationControl {
  constructor(
    private readonly gateway: AiEvaluationGateway,
    private readonly suites: EvaluationSuiteRegistry,
    @Inject(AI_EVALUATION_STORE) private readonly store: AiEvaluationStore,
    private readonly usage: AiUsage,
    @Inject(AI_GATEWAY_CONTROLS) private readonly controls: AiGatewayControls,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** Every suite with its samples' ids and synthetic input summaries (the playground's list). */
  samples(): readonly PlaygroundSuite[] {
    return this.suites.ids().flatMap((capability) => {
      const found = this.gateway.suiteOf(capability);
      if (found === null) return [];
      const { suite } = found;
      return [
        {
          capability,
          setVersion: suite.setVersion,
          samples: suite.sampleIds().map((id) => ({ id, label: suite.label(id) ?? id })),
        },
      ];
    });
  }

  /**
   * What a run of the model would cost and whether it may start now: per capability the sample
   * count and the sum of each sample's reservation (the gateway's formula, on the model's routes),
   * the evaluation budget left and what blocks it. Opens read-only units; throws when the Market's
   * settings or the budget cannot be read.
   */
  async estimate(
    context: CallContext,
    provider: string,
    family: string,
  ): Promise<EvaluationEstimate> {
    const { market } = context;
    const { marketId } = market;
    const controls = await this.controls.read(context);
    const blockers = new Set<EvaluationBlocker>();
    const capabilities: CapabilityEstimate[] = [];
    let firstProblem: RouteProblem | null = null;
    for (const capability of this.suites.ids()) {
      const found = this.gateway.suiteOf(capability);
      if (found === null) continue;
      const { suite, spec } = found;
      const plan = this.gateway.planOf(marketId, spec, provider, family);
      if (plan.length === 0) {
        firstProblem ??=
          this.gateway.problemOf(marketId, spec, provider, family) ?? 'unknown-model';
        continue;
      }
      let sum = 0;
      for (const sampleId of suite.sampleIds()) {
        const sent = this.gateway.requestOf(spec, suite, sampleId);
        sum += (sent === null ? null : this.gateway.estimateOf(sent, plan)) ?? 0;
      }
      capabilities.push({
        capability,
        promptVersion: spec.promptVersion,
        setVersion: suite.setVersion,
        samples: suite.sampleIds().length,
        estimateMicroUsd: sum,
      });
    }
    if (capabilities.length === 0) {
      blockers.add(
        firstProblem === null || firstProblem === 'not-evaluated' ? 'no-suite' : firstProblem,
      );
    }
    const open = await this.#read(market, () => this.store.hasOpenRun(market, provider, family));
    if (open) blockers.add('run-open');
    if (
      closedBySaverThreshold(
        await this.usage.monthShare(market, controls.caps),
        controls.models.saverAtPercent,
      )
    ) {
      blockers.add('saver-closed');
    }
    return {
      provider,
      family,
      capabilities,
      estimateMicroUsd: capabilities.reduce((total, item) => total + item.estimateMicroUsd, 0),
      budgetLeftMicroUsd: await this.usage.evaluationLeft(market, controls.caps),
      blockers: [...blockers],
    };
  }

  /**
   * Queues a run of the estimate's model with its capabilities, in the caller's open unit (with
   * its step-up spend and audit row). Answers the new run's id, or null when the model has an
   * open run in the Market already (nothing written).
   */
  async enqueue(
    market: MarketContext,
    estimate: EvaluationEstimate,
    requestedBy: string,
  ): Promise<string | null> {
    const id = this.ids.next<'AiEvaluationRun'>();
    const queued = await this.store.enqueue(market, {
      id,
      provider: estimate.provider,
      family: estimate.family,
      requestedBy,
      requestedAt: this.clock.now(),
      estimateMicroUsd: estimate.estimateMicroUsd,
      capabilities: estimate.capabilities.map((item) => ({
        capability: item.capability,
        promptVersion: item.promptVersion,
        setVersion: item.setVersion,
        samplesTotal: item.samples,
      })),
    });
    return queued ? id : null;
  }

  /** Cancels a queued or running run of the Market; false when it is not open (or not there). */
  async cancel(market: MarketContext, runId: string): Promise<boolean> {
    return this.#write(market, async () => {
      if (!(await this.store.cancel(market, runId, this.clock.now()))) return false;
      for (const row of await this.store.capabilitiesOf(market, runId)) {
        if (row.verdict === 'pending') {
          await this.store.setVerdict(market, runId, row.capability, 'incomplete');
        }
      }
      return true;
    });
  }

  /** A page of the Market's runs, newest first; null for a cursor that is not one. */
  async list(
    market: MarketContext,
    family: string | undefined,
    cursor: string | undefined,
  ): Promise<EvaluationRunList | null> {
    let after: { requestedAt: Temporal.Instant; id: string } | undefined;
    if (cursor !== undefined) {
      const match = CURSOR.exec(cursor);
      if (match === null) return null;
      after = {
        requestedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
        id: match[2]!,
      };
    }
    if (family !== undefined && !FAMILY.test(family)) return null;
    const rows = await this.#read(market, () =>
      this.store.listRuns(market, {
        ...(family === undefined ? {} : { family }),
        ...(after === undefined ? {} : { after }),
        limit: EVALUATION_RUNS_PAGE + 1,
      }),
    );
    const runs = rows.slice(0, EVALUATION_RUNS_PAGE);
    const last = runs.at(-1);
    return {
      runs,
      next:
        rows.length > EVALUATION_RUNS_PAGE && last !== undefined
          ? `${last.requestedAt.epochMilliseconds}.${last.id}`
          : null,
    };
  }

  /** One run of the Market with its capabilities and samples (codes and numbers), or null. */
  async detail(market: MarketContext, runId: string): Promise<EvaluationRunDetail | null> {
    return this.#read(market, async () => {
      const run = await this.store.findRun(market, runId);
      if (run === null) return null;
      const samples = await this.store.samplesOf(market, runId);
      return {
        run,
        capabilities: await this.store.capabilitiesOf(market, runId),
        samples,
        costMicroUsd: samples.reduce((total, sample) => total + sample.costMicroUsd, 0),
      };
    });
  }

  /**
   * One sample on two models side by side (design section 8, Playground). The caller sends ids
   * only: a capability with a suite, one of its sample ids and two distinct catalogue families; no
   * free text reaches a model. The admin's run is counted first in its own unit, at most
   * {@link AI_PLAYGROUND_RUNS_PER_ADMIN_DAY} per Market day; then both calls run in parallel,
   * outside any unit, through the evaluation gateway (the evaluation budget, the close rule).
   * Nothing is stored; each answer is the capability's own guarded, inert text.
   */
  async playground(
    context: CallContext,
    adminId: string,
    capability: string,
    sampleId: string,
    families: readonly string[],
  ): Promise<PlaygroundResult> {
    const found = this.gateway.suiteOf(capability);
    if (found === null) return { kind: 'invalid', path: 'capability', code: 'unknown' };
    if (!SAMPLE_ID.test(sampleId) || !found.suite.sampleIds().includes(sampleId)) {
      return { kind: 'invalid', path: 'sampleId', code: 'unknown' };
    }
    for (const [index, family] of families.entries()) {
      if (!FAMILY.test(family) || this.gateway.providerOf(family) === null) {
        return { kind: 'invalid', path: `families.${index}`, code: 'unknown-model' };
      }
    }
    const { market } = context;
    const day = this.usage.dayOf(market, this.clock.now());
    const taken = await this.#write(market, () =>
      this.store.takePlaygroundRun(market, day, adminId, AI_PLAYGROUND_RUNS_PER_ADMIN_DAY),
    );
    if (!taken) return { kind: 'limit-reached' };
    const answers = await Promise.all(
      families.map(async (family): Promise<PlaygroundAnswer> => {
        const provider = this.gateway.providerOf(family)!;
        const result = await this.gateway.run(capability, sampleId, provider, family, context);
        if (result.kind === 'refused') {
          return {
            family,
            outcome: 'refused',
            text: null,
            checks: [],
            costMicroUsd: 0,
            latencyMs: null,
            route: null,
          };
        }
        if (result.kind === 'closed') {
          return {
            family,
            outcome: result.status,
            text: null,
            checks: [],
            costMicroUsd: 0,
            latencyMs: null,
            route: null,
          };
        }
        const turn = result.turn;
        const grade =
          result.outcome === 'ok' && turn !== null ? found.suite.grade(sampleId, turn) : null;
        return {
          family,
          outcome: result.outcome,
          text: turn === null ? null : found.suite.display(sampleId, turn),
          checks: grade === null ? [] : [...new Set(grade.checks)],
          costMicroUsd: result.costMicroUsd,
          latencyMs: result.attempt?.latencyMs ?? null,
          route: result.attempt?.route.route ?? null,
        };
      }),
    );
    return { kind: 'ran', answers };
  }

  async #read<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result = await this.unitOfWork.run(market, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('evaluation store not read');
    return result.value;
  }

  async #write<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result = await this.unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('evaluation store not written');
    return result.value;
  }
}
