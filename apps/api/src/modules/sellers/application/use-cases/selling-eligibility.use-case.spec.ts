import {
  SequenceIdGenerator,
  FixedClock,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { SellersFacadeImplementation } from '../../presentation/sellers.facade';
import { SellingEligibilitySystem } from './selling-eligibility-system.use-case';
import { SellingEligibility } from './selling-eligibility.use-case';

// The fail-closed stand-in for the may-sell contract (sellers design 7.2; slice 9 replaces it).
// Both Market fixtures: the answer must not depend on the Market, the caller or the id.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z')));

describe.each(['AU', 'ZZ'])('sellingEligibility stand-in, Market %s', (code) => {
  const market = () => testMarketContext(code, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const system = () => testCallContext(market(), 'system');
  const request = new SellingEligibility(gate);
  const jobs = new SellingEligibilitySystem(gate);

  it('answers eligible: false for every distinct id, in first-occurrence order', async () => {
    const a = ids.next<'Seller'>();
    const b = ids.next<'Seller'>();

    const result = await request.execute(anonymous(), { sellerIds: [b, a, b] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value]).toEqual([
      [b, { eligible: false }],
      [a, { eligible: false }],
    ]);
  });

  it('gives the system pair the same answer', async () => {
    const a = ids.next<'Seller'>();

    const fromRequest = await request.execute(anonymous(), { sellerIds: [a] });
    const fromJob = await jobs.execute(system(), { sellerIds: [a] });

    expect(JSON.stringify([...(fromJob.ok ? fromJob.value : [])])).toBe(
      JSON.stringify([...(fromRequest.ok ? fromRequest.value : [])]),
    );
  });

  it('answers an empty list with an empty map', async () => {
    const result = await request.execute(anonymous(), { sellerIds: [] });

    expect(result.ok && result.value.size).toBe(0);
  });

  it('accepts exactly 100 ids and refuses 101, a malformed id and a non-string whole', async () => {
    const hundred = Array.from({ length: 100 }, () => ids.next<'Seller'>());
    const accepted = await request.execute(anonymous(), { sellerIds: hundred });
    expect(accepted.ok && accepted.value.size).toBe(100);

    for (const [sellerIds, fieldCode] of [
      [[...hundred, ids.next<'Seller'>()], 'length'],
      [['not-an-id'], 'format'],
      [[42 as unknown as string], 'format'],
    ] as const) {
      const refused = await request.execute(anonymous(), { sellerIds });
      expect(refused).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: fieldCode }] },
      });
    }
  });

  it('keeps each case to its own actor kind (the facade picks the pair)', async () => {
    const a = ids.next<'Seller'>();

    const jobOnRequestActor = await jobs.execute(anonymous(), { sellerIds: [a] });
    const requestOnSystem = await request.execute(system(), { sellerIds: [a] });

    expect(jobOnRequestActor.ok).toBe(false);
    expect(requestOnSystem.ok).toBe(false);
  });

  it('is answered through the facade for a request actor and for the system actor alike', async () => {
    const facade = new SellersFacadeImplementation({
      sellerSummaries: undefined as never,
      sellerSummariesSystem: undefined as never,
      sellingEligibility: request,
      sellingEligibilitySystem: jobs,
      approvedSellerZones: undefined as never,
      approvedSellerZonesSystem: undefined as never,
    });
    const a = ids.next<'Seller'>();

    for (const actor of ['anonymous', 'system'] as const) {
      const result = await facade.sellingEligibility(testCallContext(market(), actor), [a]);

      expect(result.ok).toBe(true);
      if (result.ok) expect([...result.value]).toEqual([[a, { eligible: false }]]);
    }
  });
});
