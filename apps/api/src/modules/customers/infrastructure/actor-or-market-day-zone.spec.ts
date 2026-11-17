import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { IdentityManagementPeer } from '../application/ports/customer-management-peers';
import { ActorOrMarketDayZone } from './actor-or-market-day-zone';

// The zone an admin's filter days are read in (customers management phase 2b, ADR-0005): the
// admin's own zone, else the Market's. Whatever identity answers, a zone Temporal cannot use never
// reaches a day boundary (it would be a 500), on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(['AU', 'ZZ'] as const)('the admin day zone in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const context = testCallContext(market, 'system', 'day-zone-0001');
  const marketZone = markets.get(market.marketId).timezone;
  const zoneWith = (describeActor: IdentityManagementPeer['describeActor']) =>
    new ActorOrMarketDayZone(markets, { describeActor }).zoneOf(context);

  it('is the admin’s own zone when it is a valid IANA id', async () => {
    const own = marketZone === 'Pacific/Auckland' ? 'Europe/Berlin' : 'Pacific/Auckland';
    await expect(zoneWith(() => Promise.resolve(ok({ timezone: own })))).resolves.toBe(own);
  });

  it.each([
    ['identity refuses', () => Promise.resolve(err({ code: 'access.denied' }))],
    ['identity throws', () => Promise.reject(new Error('identity down'))],
    ['identity returns null', () => Promise.resolve(ok({ timezone: null }))],
    ['identity returns no zone', () => Promise.resolve(ok({}))],
    ['identity returns an empty string', () => Promise.resolve(ok({ timezone: '' }))],
    [
      'identity returns an invalid id',
      () => Promise.resolve(ok({ timezone: 'Mars/Olympus_Mons' })),
    ],
    ['identity returns garbage', () => Promise.resolve(ok({ timezone: '../../etc/passwd' }))],
  ] as const)('falls back to the Market’s zone when %s', async (_case, describeActor) => {
    await expect(zoneWith(describeActor as IdentityManagementPeer['describeActor'])).resolves.toBe(
      marketZone,
    );
  });
});
