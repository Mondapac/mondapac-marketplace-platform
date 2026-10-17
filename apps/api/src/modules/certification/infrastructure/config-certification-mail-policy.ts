import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CertificationMailPolicy } from '../application/ports/review.ports';

/** The Market's mail sender (the one identity's mail uses), read from its configuration. */
export class ConfigCertificationMailPolicy implements CertificationMailPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  mailSender(market: MarketContext): { readonly address: string; readonly name: string } {
    const { fromAddress, fromName } = this.markets.get(market.marketId).identity.mail;
    return { address: fromAddress, name: fromName };
  }
}
