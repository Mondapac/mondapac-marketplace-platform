import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { AddressPolicy } from '../application/ports/address-policy';

/** The Market's `customers` settings: the address book limit and the address format. */
export class ConfigAddressPolicy implements AddressPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  settings(market: MarketContext) {
    const customers = this.markets.get(market.marketId).customers;
    return customers === undefined
      ? null
      : { limit: customers.addressBookLimit, format: customers.address };
  }
}
