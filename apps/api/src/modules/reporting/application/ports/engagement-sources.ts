import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';

/** A Market day's funnel as its owners count it: distinct customers, each step within the last. */
export interface FunnelCounts {
  readonly viewed: number;
  readonly carted: number;
  readonly checkedOut: number;
  readonly paid: number;
}

/**
 * Why a day's funnel could not be counted now: an owner refused or failed (its code), or the day
 * had more checkouts than one read answers. The snapshot skips the day and tries it next run.
 */
export interface FunnelUnavailable {
  readonly code: string;
}

/**
 * What the nightly snapshot reads of the owners (dashboards v2, phase 2): ordering's checkouts of
 * the window handed straight to engagement's funnel count, as the system actor. Only the counts
 * come back to reporting's application layer; the accounts stay inside the adapter's one call.
 */
export interface EngagementSources {
  funnelOf(
    context: CallContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
  ): Promise<Result<FunnelCounts, FunnelUnavailable>>;
}

export const ENGAGEMENT_SOURCES = Symbol('reporting.EngagementSources');
