import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type {
  BusinessIdentifierScheme,
  BusinessIdentifierSchemes,
} from '../../application/ports/business-identifier-scheme';
import { ABN_SCHEME, abnScheme } from './abn';
import { ZZ_CORP_NO_SCHEME, zzCorpNoScheme } from './zz-corp-no';

/**
 * The adapters of {@link BusinessIdentifierScheme}, one file per scheme (sellers design 4.2),
 * by the scheme code Market configuration names. Adding a scheme is a file here and a line below,
 * never a branch in the core (ADR-0001 decision 5).
 */
export const IDENTIFIER_SCHEME_ADAPTERS: ReadonlyMap<string, BusinessIdentifierScheme> = new Map([
  [ABN_SCHEME, abnScheme],
  [ZZ_CORP_NO_SCHEME, zzCorpNoScheme],
]);

/** A hosted Market names a scheme no adapter implements: the Region Stack must not start. */
export class UnknownIdentifierSchemeError extends Error {
  override readonly name = 'UnknownIdentifierSchemeError';
  constructor(
    readonly marketId: string,
    readonly scheme: string,
  ) {
    super(
      `Market "${marketId}" names the business identifier scheme "${scheme}", ` +
        'which has no adapter in sellers/infrastructure/identifier-schemes/',
    );
  }
}

/**
 * {@link BusinessIdentifierSchemes} on the Market configuration (sellers design 4.1, 4.2). The
 * constructor is the start-up check: every hosted Market that has a `sellers` section must name
 * a scheme with an adapter, or it throws {@link UnknownIdentifierSchemeError} (the platform does
 * not know the module's adapters, so the configuration schema cannot check this itself).
 */
export class MarketConfigIdentifierSchemes implements BusinessIdentifierSchemes {
  readonly #byMarket = new Map<string, BusinessIdentifierScheme>();

  constructor(
    markets: MarketRegistry,
    adapters: ReadonlyMap<string, BusinessIdentifierScheme> = IDENTIFIER_SCHEME_ADAPTERS,
  ) {
    for (const marketId of markets.hostedMarketIds()) {
      const identifier = markets.get(marketId).sellers?.businessIdentifier;
      if (identifier === undefined) continue;
      const adapter = adapters.get(identifier.scheme);
      if (adapter === undefined)
        throw new UnknownIdentifierSchemeError(marketId, identifier.scheme);
      this.#byMarket.set(marketId, adapter);
    }
  }

  schemeOf(market: MarketContext): BusinessIdentifierScheme | null {
    return this.#byMarket.get(market.marketId) ?? null;
  }
}
