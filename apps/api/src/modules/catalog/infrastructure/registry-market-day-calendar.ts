import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { MarketDayCalendar } from '../application/ports/description-writer';

/** {@link MarketDayCalendar} in the Market's configured time zone (Market configuration). */
export class RegistryMarketDayCalendar implements MarketDayCalendar {
  constructor(private readonly markets: MarketRegistry) {}

  zoneOf(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }

  dayOf(market: MarketContext, at: Temporal.Instant): string {
    return at.toZonedDateTimeISO(this.zoneOf(market)).toPlainDate().toString();
  }

  nextMidnight(market: MarketContext, at: Temporal.Instant): Temporal.Instant {
    const zoned = at.toZonedDateTimeISO(this.zoneOf(market));
    return zoned.toPlainDate().add({ days: 1 }).toZonedDateTime(this.zoneOf(market)).toInstant();
  }
}
