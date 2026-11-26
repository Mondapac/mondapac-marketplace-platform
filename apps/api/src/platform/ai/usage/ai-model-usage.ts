import { Inject, Injectable } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { Clock, MarketContext } from '@mondapac/shared-kernel';
import { CLOCK } from '../../clock/clock.module';
import { MarketRegistry } from '../../market-config/market-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../unit-of-work/unit-of-work';
import { CAPABILITY_TASKS, type CapabilityTask } from '../capability';
import { CapabilityRegistry } from '../capability-registry';
import { AiRouter } from '../routing/ai-router';
import { AI_EVALUATION_USAGE } from './ai-usage';
import {
  AI_USAGE_STORE,
  LATENCY_BUCKETS_MS,
  type AiUsageStore,
  type CapabilityTokenTotals,
  type ModelCallTotals,
} from './ai-usage-store';

/** The scorecard and the monthly estimate read the last 30 days (design section 8). */
export const MODEL_USAGE_DAYS = 30;

/** The p95 latency bucket: at most `bound` ms, or slower than the last bound when `above`. */
export interface LatencyBucket {
  readonly bound: number;
  readonly above: boolean;
}

/** One model family's calls in the window, for the scorecard. Numbers and codes only. */
export interface FamilyUsage {
  readonly family: string;
  readonly provider: string;
  readonly calls: number;
  /** Calls that did not answer (timeout, no answer, rate limit, refused by the provider). */
  readonly failures: number;
  /** Calls the family answered or tried as a later attempt, after another route failed. */
  readonly stoodIn: number;
  readonly costMicroUsd: number;
  /** The bucket that holds the 95th percentile of the calls' latency; null without calls. */
  readonly p95: LatencyBucket | null;
  /** Registered capabilities with a recorded evaluation pass of the family, and all of them. */
  readonly evaluation: { readonly passed: number; readonly of: number };
}

/** One task type's calls and tokens in the window, and what they would cost per family. */
export interface TaskUsage {
  readonly task: CapabilityTask;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Per catalogue family, the window's tokens at the family's price in the Market (its dearest
   * usable route, as the reservation counts it); null when no route of it is usable for the task.
   */
  readonly costByFamily: readonly {
    readonly family: string;
    readonly costMicroUsd: number | null;
  }[];
}

export interface ModelUsageView {
  /** The first and last Market day of the window (both included). */
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly families: readonly FamilyUsage[];
  readonly tasks: readonly TaskUsage[];
}

/** The bucket of the 95th percentile from cumulative counts at each bound (nearest rank). */
export function p95Of(calls: number, atMostMs: readonly number[]): LatencyBucket | null {
  if (calls <= 0) return null;
  const rank = Math.ceil(calls * 0.95);
  for (const [index, bound] of LATENCY_BUCKETS_MS.entries()) {
    if ((atMostMs[index] ?? 0) >= rank) return { bound, above: false };
  }
  return { bound: LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]!, above: true };
}

/**
 * Tokens at a price in pico US dollars per token, in micro US dollars rounded up (an estimate
 * never under-counts). In BigInt: a month of tokens times a price can pass 2^53.
 */
export function tokensCostMicroUsd(
  inputTokens: number,
  outputTokens: number,
  price: { readonly inputPicoUsd: number; readonly outputPicoUsd: number },
): number {
  const pico =
    BigInt(inputTokens) * BigInt(price.inputPicoUsd) +
    BigInt(outputTokens) * BigInt(price.outputPicoUsd);
  return Number((pico + 999_999n) / 1_000_000n);
}

/**
 * The usage read of the AI Models page (AI Gateway G5e; docs/design/domain/platform-ai.md section
 * 8, Tab 1, Scorecard and Change preview), for `settings`, which owns the admin API and checks the
 * caller's access first. Per model family: calls, failures, stand-ins, cost and p95 latency of the
 * last 30 days, from `platform.ai_calls` (the day rows have no model), with evaluation calls left
 * out; per task type: the calls and tokens of the day rows and what they would cost on each family.
 *
 * Numbers, codes and catalogue names only: no text, prompt, answer, customer, seller or call id.
 * Reads in one read-only unit of its own, for the caller's Market only, so it is never called
 * inside a unit. Calls no model (boundary rule `ai-model-usage-only-from-settings`).
 */
@Injectable()
export class AiModelUsage {
  constructor(
    @Inject(AI_USAGE_STORE) private readonly store: AiUsageStore,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly markets: MarketRegistry,
    private readonly router: AiRouter,
    private readonly capabilities: CapabilityRegistry,
  ) {}

  /** The last 30 days of the caller's Market. Throws when the store cannot be read. */
  async read(market: MarketContext): Promise<ModelUsageView> {
    const now = this.clock.now();
    const zone = this.markets.get(market.marketId).timezone;
    const to = now.toZonedDateTimeISO(zone).toPlainDate();
    const from = to.subtract({ days: MODEL_USAGE_DAYS - 1 });
    // The calls of the same Market days: from the start of `from` in the Market's zone to now.
    const since = from.toZonedDateTime({ timeZone: zone }).toInstant();
    const read = await this.unitOfWork.run(
      market,
      async () =>
        ok({
          calls: await this.store.callTotalsByModel(market, since, now, AI_EVALUATION_USAGE),
          tokens: await this.store.tokenTotalsByCapability(market, from, to, AI_EVALUATION_USAGE),
        }),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('AI usage could not be read');
    return {
      from: from.toString(),
      to: to.toString(),
      days: MODEL_USAGE_DAYS,
      families: this.#families(read.value.calls),
      tasks: this.#tasks(market, read.value.tokens),
    };
  }

  #families(calls: readonly ModelCallTotals[]): FamilyUsage[] {
    const specs = this.capabilities.ids().map((id) => this.capabilities.get(id)!);
    const byFamily = new Map<string, ModelCallTotals[]>();
    for (const row of calls) {
      // A model no catalogue row names any more (a removed row) has no family to show.
      const family = this.router.familyOfModel(row.provider, row.model);
      if (family === null) continue;
      byFamily.set(family, [...(byFamily.get(family) ?? []), row]);
    }
    return this.router.families().map((family) => {
      const rows = byFamily.get(family) ?? [];
      const sum = (pick: (row: ModelCallTotals) => number): number =>
        rows.reduce((total, row) => total + pick(row), 0);
      const total = sum((row) => row.calls);
      const atMost = LATENCY_BUCKETS_MS.map((_, index) => sum((row) => row.atMostMs[index] ?? 0));
      return {
        family,
        provider: this.router.providerOf(family) ?? '',
        calls: total,
        failures: sum((row) => row.failures),
        stoodIn: sum((row) => row.laterAttempts),
        costMicroUsd: sum((row) => row.costMicroUsd),
        p95: p95Of(total, atMost),
        evaluation: {
          passed: specs.filter((spec) => this.router.familyPassed(spec, family)).length,
          of: specs.length,
        },
      };
    });
  }

  #tasks(market: MarketContext, tokens: readonly CapabilityTokenTotals[]): TaskUsage[] {
    const families = this.router.families();
    return CAPABILITY_TASKS.map((task) => {
      // Only registered capabilities count: a day row of a capability no longer registered has
      // no task type.
      const rows = tokens.filter((row) => this.capabilities.get(row.capability)?.task === task);
      const calls = rows.reduce((total, row) => total + row.calls, 0);
      const inputTokens = rows.reduce((total, row) => total + row.inputTokens, 0);
      const outputTokens = rows.reduce((total, row) => total + row.outputTokens, 0);
      return {
        task,
        calls,
        inputTokens,
        outputTokens,
        costByFamily: families.map((family) => {
          const price = this.router.familyPrice(market.marketId, task, family);
          return {
            family,
            costMicroUsd:
              price === null ? null : tokensCostMicroUsd(inputTokens, outputTokens, price),
          };
        }),
      };
    });
  }
}
