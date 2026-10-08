import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  BusinessRegisterLookup,
  BusinessRegisterLookups,
} from '../../application/ports/business-register-lookup';
import type { RegisterLookupPolicy } from '../../application/ports/register-lookup-policy';
import { NoneRegisterLookup } from './none';

/** Market configuration names an adapter that no file implements: refused, never replaced. */
export class UnknownRegisterLookupAdapterError extends Error {
  override readonly name = 'UnknownRegisterLookupAdapterError';
  constructor(
    readonly marketId: string,
    readonly adapter: string,
  ) {
    super(
      `Market "${marketId}" names the register lookup adapter "${adapter}", which has no ` +
        'adapter in sellers/infrastructure/register-lookups/',
    );
  }
}

/**
 * {@link BusinessRegisterLookups} on the Market configuration (sellers design 4.1, 4.2): the
 * adapter a Market's settings name, by code. A Market with no register is `none` (the default).
 * The adapters are passed in, so the composition root decides which exist in this environment
 * (the `fake` only where `assertFakeRegisterLookupAllowed` passes); a name with no adapter
 * throws {@link UnknownRegisterLookupAdapterError}, which the caller turns into
 * `sellers.unavailable`: it never falls back to another adapter or Market.
 */
export class MarketConfigRegisterLookups implements BusinessRegisterLookups {
  readonly #none = new NoneRegisterLookup();

  constructor(
    private readonly policy: RegisterLookupPolicy,
    private readonly adapters: ReadonlyMap<string, BusinessRegisterLookup>,
  ) {}

  of(market: MarketContext): BusinessRegisterLookup {
    const settings = this.policy.settingsOf(market);
    if (settings.kind === 'none') return this.#none;
    const adapter = this.adapters.get(settings.adapter);
    if (adapter === undefined) {
      throw new UnknownRegisterLookupAdapterError(market.marketId, settings.adapter);
    }
    return adapter;
  }
}
