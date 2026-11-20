import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { RegistryMarketCalendar } from './registry-market-calendar';

// The insights read the Market's own days: a day starts at local midnight, not at UTC midnight,
// and a day is as long as its zone says (23 or 25 hours on a daylight-saving change).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const calendar = new RegistryMarketCalendar(markets);

describe.each(TEST_MARKET_IDS)('the assistant market calendar in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const zone = markets.get(market.marketId).timezone;
  const instants = [
    '2026-01-01T00:00:00Z',
    '2026-03-28T13:59:59Z',
    '2026-03-28T14:00:00Z',
    '2026-04-04T15:30:00Z',
    '2026-10-03T14:30:00Z',
    '2026-10-18T15:00:00Z',
    '2026-11-10T23:59:59Z',
  ].map((value) => Temporal.Instant.from(value));

  it.each(instants.map((instant) => [instant.toString(), instant] as const))(
    'puts %s inside its own day, [start of the day, start of the next)',
    (_label, instant) => {
      const day = calendar.dayOf(market, instant);
      const start = calendar.startOf(market, day);
      const next = calendar.startOf(market, day.add({ days: 1 }));
      expect(Temporal.Instant.compare(start, instant)).toBeLessThanOrEqual(0);
      expect(Temporal.Instant.compare(instant, next)).toBeLessThan(0);
      expect(calendar.dayOf(market, start).equals(day)).toBe(true);
      expect(calendar.dayOf(market, next.subtract({ nanoseconds: 1 })).equals(day)).toBe(true);
    },
  );

  it('starts a day at local midnight and is as long as the zone says', () => {
    const day = Temporal.PlainDate.from('2026-10-18');
    const start = calendar.startOf(market, day);
    expect(start.toZonedDateTimeISO(zone).toPlainTime().toString()).toBe('00:00:00');
    const hours = calendar
      .startOf(market, day.add({ days: 1 }))
      .since(start, { largestUnit: 'hours' }).hours;
    expect(hours).toBe(day.toZonedDateTime(zone).hoursInDay);
  });
});
