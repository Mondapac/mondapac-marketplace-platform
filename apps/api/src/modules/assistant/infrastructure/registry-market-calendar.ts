import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { MarketCalendar } from '../application/ports/market-calendar';

/** {@link MarketCalendar} in the Market's configured time zone (Market configuration `timezone`). */
export class RegistryMarketCalendar implements MarketCalendar {
  constructor(private readonly markets: MarketRegistry) {}

  dayOf(market: MarketContext, at: Temporal.Instant): Temporal.PlainDate {
    return at.toZonedDateTimeISO(this.markets.get(market.marketId).timezone).toPlainDate();
  }
}
