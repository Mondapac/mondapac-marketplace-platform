import type { MarketContext } from '@mondapac/shared-kernel';
import type { ReservedWords } from '../../domain/reserved-words';

/**
 * The Market values `sellers` reads (sellers design 7.6). Until the ADR-0026 store lands (slice
 * 15) every value comes from Market configuration.
 */
export interface BusinessIdentifierRule {
  /** The scheme code that names an adapter in `infrastructure/identifier-schemes/`. */
  readonly scheme: string;
  /** Whether a draft needs an identifier to be complete (design 3.1, Q3). */
  readonly required: boolean;
  /** The translation key of the field's label. */
  readonly labelKey: string;
}

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

  /**
   * The Market's business identifier rule (design 4.1: `sellers.businessIdentifier`). Null for a
   * Market with no `sellers` section: the caller refuses, it never assumes a scheme or that an
   * identifier is optional.
   */
  businessIdentifier(market: MarketContext): BusinessIdentifierRule | null;
}

export const SELLER_MARKET_POLICY = Symbol('SELLER_MARKET_POLICY');
