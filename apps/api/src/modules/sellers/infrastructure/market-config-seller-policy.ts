import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SellerMarketPolicy } from '../application/ports/seller-market-policy';
import { reservedWordsOf, type ReservedWords } from '../domain/reserved-words';

/**
 * The adapter of {@link SellerMarketPolicy} (sellers design 7.6, 14.1): the `sellers` section of
 * the Market's configuration, validated and frozen at boot. A Market this Region Stack does not
 * host throws (`MarketNotHostedError`); it never falls back to another Market. Until the
 * ADR-0026 store lands (slice 15) the configured value is the value; a Market with no `sellers`
 * section gets the safe value `true` for approval (ADR-0026 decision 5), declared here in code
 * and never in `config/markets/`, and no reserved words (null: the caller refuses).
 */
export class MarketConfigSellerPolicy implements SellerMarketPolicy {
  readonly #reserved = new Map<string, ReservedWords>();

  constructor(private readonly markets: MarketRegistry) {}

  approvalRequired(market: MarketContext): boolean {
    return this.markets.get(market.marketId).sellers?.approvalRequired ?? true;
  }

  reservedWords(market: MarketContext): ReservedWords | null {
    const sellers = this.markets.get(market.marketId).sellers;
    if (sellers === undefined) return null;
    let words = this.#reserved.get(market.marketId);
    if (words === undefined) {
      words = reservedWordsOf(sellers.reservedWords);
      this.#reserved.set(market.marketId, words);
    }
    return words;
  }
}
