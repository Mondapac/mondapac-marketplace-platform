import { Inject, Injectable } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { MarketRegistry } from '../../market-config/market-registry';
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
 * A module's read of its own capabilities' usage and its "cap reached" record (AI Gateway G7;
 * docs/design/domain/platform-ai.md section 10), from {@link AiUsageReport.for}. It replaces the
 * assistant's own `spend_days` table: the gateway counts every call, so the module's cap check and
 * statistics read the gateway's day rows. Numbers only (no text, customer or call detail), and it
 * never changes what is held or spent. Every method runs in the caller's unit, for that unit's
 * Market, and rejects a capability the owner did not register (Hassan, PR 1354 finding 1), so a
 * module can neither read another module's spend nor take its once-a-day record.
 */
export interface CapabilityUsageReport {
  /** The capability's settled cost on each Market day from `from` to `to`; days without calls are left out. */
  costByDay(
    market: MarketContext,
    capability: string,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly DayCost[]>;
  /**
   * Records that a cap switched the capability off on `day`, the Market day of `at` (a later day is
   * refused); true only for the first record of that day, so the module notifies at most once a
   * day. Read-write unit.
   */
  markCapReached(
    market: MarketContext,
    capability: string,
    day: Temporal.PlainDate,
    period: BudgetPeriod,
    at: Temporal.Instant,
  ): Promise<boolean>;
  /** The capability's newest "cap reached" record in the Market, or null. */
  lastCapReached(market: MarketContext, capability: string): Promise<CapReached | null>;
}

/**
 * The gateway port behind {@link CapabilityUsageReport}, exported by `AiModule`. Only the files on
 * the checked-in allow-list import it (`.dependency-cruiser.cjs`, rule
 * ai-usage-report-only-from-the-allow-list), and each owner takes the handle for its own
 * capabilities in its providers file.
 */
@Injectable()
export class AiUsageReport {
  constructor(
    @Inject(AI_USAGE_STORE) private readonly store: AiUsageStore,
    private readonly registry: CapabilityRegistry,
    private readonly markets: MarketRegistry,
  ) {}

  /** The handle of one module (`assistant`, `catalog`, ...): only capabilities `<owner>.*`. */
  for(owner: string): CapabilityUsageReport {
    if (!/^[a-z][a-z0-9-]*$/.test(owner)) throw new Error(`"${owner}" is not a module name`);
    const own = (capability: string): void => {
      // A capability id starts with its owner's name (CapabilityRegistry checks it at boot).
      if (!capability.startsWith(`${owner}.`) || this.registry.get(capability) === undefined) {
        throw new Error(`"${owner}" has no AI capability "${capability}"`);
      }
    };
    return {
      costByDay: async (market, capability, from, to) => {
        own(capability);
        return this.store.costByDay(market, capability, from, to);
      },
      markCapReached: async (market, capability, day, period, at) => {
        own(capability);
        const today = at
          .toZonedDateTimeISO(this.markets.get(market.marketId).timezone)
          .toPlainDate();
        if (Temporal.PlainDate.compare(day, today) > 0) {
          throw new Error(
            `A cap cannot be reached on ${day.toString()}, after ${today.toString()}`,
          );
        }
        return this.store.markCapReached(market, capability, day, period, at);
      },
      lastCapReached: async (market, capability) => {
        own(capability);
        return this.store.lastCapReached(market, capability);
      },
    };
  }
}
