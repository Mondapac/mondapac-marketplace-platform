import type { MarketContext } from '@mondapac/shared-kernel';
import type { SellerHealthSettings } from '../../domain/seller-health';
import type { SellerHealthWindows } from '../../domain/seller-health-days';

/**
 * The Market's seller health settings (ADM-06; the editable store and its admin page come in a
 * later package). Read in the caller's unit; a failed read throws, and nothing is computed.
 */
export interface SellerHealthPolicy {
  settings(market: MarketContext): Promise<{
    readonly thresholds: SellerHealthSettings;
    readonly windows: SellerHealthWindows;
  }>;
}

export const SELLER_HEALTH_POLICY = Symbol('SELLER_HEALTH_POLICY');
