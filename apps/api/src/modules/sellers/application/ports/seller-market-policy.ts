import type { MarketContext } from '@mondapac/shared-kernel';
import type { ReservedWords } from '../../domain/reserved-words';

/**
 * The Market values `sellers` reads (sellers design 7.6). Until the ADR-0026 store lands (slice
 * 15) every value comes from Market configuration.
 */
export interface SellerMarketPolicy {
  /**
   * Whether a new seller needs approval. A Market with no value gets the safe value `true`
   * (ADR-0026 decision 5), never another Market's value.
   */
  approvalRequired(market: MarketContext): boolean;

  /**
   * The Market's reserved slugs and claim words (design 3.5; `sellers.reservedWords`). Null for
   * a Market with no `sellers` section: the caller refuses, it never checks against nothing.
   */
  reservedWords(market: MarketContext): ReservedWords | null;
}

export const SELLER_MARKET_POLICY = Symbol('SELLER_MARKET_POLICY');
