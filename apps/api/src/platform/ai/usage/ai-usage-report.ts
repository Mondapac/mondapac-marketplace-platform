import { Inject, Injectable } from '@nestjs/common';
import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import { CapabilityRegistry } from '../capability-registry';
import {
  AI_USAGE_STORE,
  type AiUsageStore,
  type BudgetPeriod,
  type CapReached,
  type DayCost,
} from './ai-usage-store';

export type { CapReached, DayCost };

/**
 * The gateway port through which a module reads its own capability's spend and keeps its "cap
 * reached" record (AI Gateway G7; docs/design/domain/platform-ai.md section 10). It replaces the
 * assistant's own `spend_days` table: the gateway counts every call, so the module's cap check and
 * statistics read the gateway's day rows. Numbers only (no text, customer or call detail), and it
 * never changes what is held or spent; only a module's infrastructure imports it
 * (`.dependency-cruiser.cjs`, rule ai-usage-report-only-from-module-infrastructure). Every method
 * runs in the caller's unit, for that unit's Market; an unknown capability throws, so a typo can
 * never read as "nothing spent".
 */
@Injectable()
export class AiUsageReport {
  constructor(
    @Inject(AI_USAGE_STORE) private readonly store: AiUsageStore,
    private readonly registry: CapabilityRegistry,
  ) {}

  /** The capability's settled cost on each Market day from `from` to `to`; days without calls are left out. */
  costByDay(
    market: MarketContext,
    capability: string,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly DayCost[]> {
    this.#known(capability);
    return this.store.costByDay(market, capability, from, to);
  }

  /**
   * Records that a cap switched the capability off on `day` (the Market's day); true only for the
   * first record of that day, so the module notifies at most once a day. Read-write unit.
   */
  markCapReached(
    market: MarketContext,
    capability: string,
    day: Temporal.PlainDate,
    period: BudgetPeriod,
    at: Temporal.Instant,
  ): Promise<boolean> {
    this.#known(capability);
    return this.store.markCapReached(market, capability, day, period, at);
  }

  /** The capability's newest "cap reached" record in the Market, or null. */
  lastCapReached(market: MarketContext, capability: string): Promise<CapReached | null> {
    this.#known(capability);
    return this.store.lastCapReached(market, capability);
  }

  #known(capability: string): void {
    if (this.registry.get(capability) === undefined) {
      throw new Error(`Unknown AI capability "${capability}"`);
    }
  }
}
