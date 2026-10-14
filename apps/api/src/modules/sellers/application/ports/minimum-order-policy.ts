import type { MarketContext } from '@mondapac/shared-kernel';
import type { MinimumOrderRule } from '../../domain/minimum-order';

/**
 * The Market values a minimum order is checked against (sellers design 18 decision 3): the
 * Market currency and `sellers.minimumOrderMax`, from Market configuration.
 */
export interface MinimumOrderPolicy {
  /** Null for a Market with no `sellers` section: the caller refuses and reads nothing as a minimum. */
  rule(market: MarketContext): MinimumOrderRule | null;
}

export const MINIMUM_ORDER_POLICY = Symbol('MINIMUM_ORDER_POLICY');
