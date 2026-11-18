import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { InvitationRulesSource } from '../application/seller-invitations-flow';
import type { InvitationRules } from '../domain/seller-invitations';

/** The Market's `customers.invitations` settings; null when the Market has none (feature off). */
export class ConfigInvitationRules implements InvitationRulesSource {
  constructor(private readonly markets: MarketRegistry) {}

  rulesOf(market: MarketContext): InvitationRules | null {
    return this.markets.get(market.marketId).customers?.invitations ?? null;
  }
}
