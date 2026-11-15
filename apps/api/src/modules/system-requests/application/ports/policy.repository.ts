import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PolicyArea, Risk } from '../../domain/areas';

export interface AreaPolicyRecord {
  readonly area: PolicyArea;
  readonly enabled: boolean;
  readonly risk: Risk;
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
}

export interface DueDaysRecord {
  readonly reviewDueDays: number;
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
}

export interface Stamp {
  readonly version: number;
  readonly at: Temporal.Instant;
  readonly by: Id<'Account'>;
}

/**
 * `system_requests.policy_areas` and `policy_settings`, scoped by the Market. A missing row is
 * the default declared in code. Writes take the version they replace (`stamp.version - 1`; 0 is
 * no row) and answer false when another change got there first.
 */
export interface PolicyRepository {
  areas(market: MarketContext): Promise<readonly AreaPolicyRecord[]>;
  area(market: MarketContext, area: PolicyArea): Promise<AreaPolicyRecord | null>;
  setArea(
    market: MarketContext,
    area: PolicyArea,
    value: { readonly enabled: boolean; readonly risk: Risk },
    stamp: Stamp,
  ): Promise<boolean>;
  dueDays(market: MarketContext): Promise<DueDaysRecord | null>;
  setDueDays(market: MarketContext, days: number, stamp: Stamp): Promise<boolean>;
}

export const POLICY_REPOSITORY = Symbol('SYSTEM_REQUESTS_POLICY_REPOSITORY');
