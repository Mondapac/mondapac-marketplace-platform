import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { IdentityFacade } from '../../identity';
import type {
  OfferOwnerContact,
  OfferOwnerMailSettings,
} from '../application/ports/offer-owner-notices';

/**
 * {@link OfferOwnerContact} on `identity.contactEmailOf` (request R-4, as certification's): the
 * Seller Owner's sign-in address for the `system` caller. A refusal throws, so the delivery is
 * retried; the address is returned to one send and never logged.
 */
export class IdentityOfferOwnerContact implements OfferOwnerContact {
  constructor(private readonly identity: IdentityFacade) {}

  async emailOf(context: CallContext, sellerId: Id<'Seller'>): Promise<string | null> {
    const found = await this.identity.contactEmailOf(context, { kind: 'seller-owner', sellerId });
    if (!found.ok) throw new Error('offer-owner-notice: the address could not be read');
    return found.value;
  }
}

/** {@link OfferOwnerMailSettings} from the Market's configuration (no default Market). */
export class ConfigOfferOwnerMailSettings implements OfferOwnerMailSettings {
  constructor(private readonly markets: MarketRegistry) {}

  sender(market: MarketContext): { readonly address: string; readonly name: string } {
    const { fromAddress, fromName } = this.markets.get(market.marketId).identity.mail;
    return { address: fromAddress, name: fromName };
  }

  zone(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }
}
