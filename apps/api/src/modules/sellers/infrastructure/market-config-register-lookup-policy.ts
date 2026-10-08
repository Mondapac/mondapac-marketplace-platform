import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  RegisterLookupPolicy,
  RegisterLookupSettings,
} from '../application/ports/register-lookup-policy';
import { UnknownRegisterLookupAdapterError } from './register-lookups';
import { NONE_REGISTER_ADAPTER } from './register-lookups/none';

/**
 * {@link RegisterLookupPolicy} on the `sellers.registerLookup` section of the Market
 * configuration (sellers design 4.1, 4.2), read once and frozen. The constructor is the start-up
 * check (Hassan L3): every hosted Market that has a `sellers` section must name `none` or an
 * adapter this environment has, or it throws {@link UnknownRegisterLookupAdapterError} and the
 * Region Stack does not start. A Market never reads another Market's values, and a Market with
 * no `sellers` section has no register (`none`).
 */
export class MarketConfigRegisterLookupPolicy implements RegisterLookupPolicy {
  readonly #byMarket = new Map<string, RegisterLookupSettings>();

  constructor(markets: MarketRegistry, availableAdapters: ReadonlySet<string>) {
    for (const marketId of markets.hostedMarketIds()) {
      const lookup = markets.get(marketId).sellers?.registerLookup;
      if (lookup === undefined || lookup.adapter === NONE_REGISTER_ADAPTER) {
        this.#byMarket.set(marketId, { kind: 'none' });
        continue;
      }
      if (!availableAdapters.has(lookup.adapter)) {
        throw new UnknownRegisterLookupAdapterError(marketId, lookup.adapter);
      }
      this.#byMarket.set(marketId, {
        kind: 'configured',
        adapter: lookup.adapter,
        maxResultAgeDays: lookup.maxResultAgeDays,
        perAccountLimit: lookup.perAccountLimit,
        perOriginLimit: lookup.perOriginLimit,
        marketDailyBudget: lookup.marketDailyBudget,
        legalSuffixes: Object.freeze([...lookup.legalSuffixes]),
      });
    }
  }

  settingsOf(market: MarketContext): RegisterLookupSettings {
    const settings = this.#byMarket.get(market.marketId);
    if (settings === undefined) throw new Error(`Market "${market.marketId}" is not hosted here`);
    return settings;
  }
}
