import type { MarketContext } from '@mondapac/shared-kernel';

/**
 * The Market values `sellers` reads (sellers design 7.6). Slice 1 needs one: whether a new
 * seller needs approval. Until the ADR-0026 store lands (slice 15) the value comes from Market
 * configuration; a Market with no value gets the safe value `true` (ADR-0026 decision 5), never
 * another Market's value.
 */
export interface SellerMarketPolicy {
  approvalRequired(market: MarketContext): boolean;
}

export const SELLER_MARKET_POLICY = Symbol('SELLER_MARKET_POLICY');
