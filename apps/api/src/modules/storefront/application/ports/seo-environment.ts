import type { CallContext } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';

/**
 * The server-side facts that bound the indexing switch (plan 3.1 item 4). The env is an off-only
 * ceiling, like `AI_KILL_SWITCH`: it can keep indexing off, never turn it on. While the storefront
 * runs on sample data the switch cannot be turned on at all.
 */
export interface SeoEnvironment {
  /** `STOREFRONT_INDEXING`: `off` (also when unset) keeps every page out of the index. */
  ceiling(market: MarketContext): 'on' | 'off';
  /** True while the storefront shows sample data (`STOREFRONT_SAMPLE_DATA`, on unless set off). */
  sampleDataLock(market: MarketContext): boolean;
}

export const SEO_ENVIRONMENT = Symbol('SEO_ENVIRONMENT');

/** A use case that only answers whether the caller holds `storefront.seo.manage` (a gate probe). */
export interface SeoManageProbe {
  execute(context: CallContext, input: Record<string, never>): Promise<{ readonly ok: boolean }>;
}

export const SEO_MANAGE_PROBE = Symbol('SEO_MANAGE_PROBE');
