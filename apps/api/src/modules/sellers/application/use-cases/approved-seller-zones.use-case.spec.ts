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
import { ApprovedSellerZonesSystem } from './approved-seller-zones-system.use-case';
import { ApprovedSellerZones } from './approved-seller-zones.use-case';

// The contract of approvedSellerZones before slice 5 (sellers design 7.1a; certification #124):
// no approved revision exists, so every id answers { zone: null, addressZone: null }.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z')));
const NONE = { zone: null, addressZone: null };

describe.each(['AU', 'ZZ'])('approvedSellerZones contract, Market %s', (code) => {
  const market = () => testMarketContext(code, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const system = () => testCallContext(market(), 'system');
  const request = new ApprovedSellerZones(gate);
  const jobs = new ApprovedSellerZonesSystem(gate);
  const facade = new SellersFacadeImplementation({
    sellerSummaries: undefined as never,
    sellerSummariesSystem: undefined as never,
    sellingEligibility: undefined as never,
    sellingEligibilitySystem: undefined as never,
    approvedSellerZones: request,
    approvedSellerZonesSystem: jobs,
  });

  it('answers the pair of nulls, one key per distinct id, in first-occurrence order', async () => {
    const a = ids.next<'Seller'>();
    const b = ids.next<'Seller'>();
    const c = ids.next<'Seller'>();

    const result = await request.execute(anonymous(), { sellerIds: [b, a, b, c, a] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.keys()]).toEqual([b, a, c]);
    expect([...result.value.values()]).toEqual([NONE, NONE, NONE]);
  });

  it('answers an empty list with an empty map', async () => {
    const result = await request.execute(anonymous(), { sellerIds: [] });

    expect(result.ok && result.value.size).toBe(0);
  });

  it('accepts 100 distinct ids and refuses 101 entries, 101 duplicates and a malformed id whole', async () => {
    const hundred = Array.from({ length: 100 }, () => ids.next<'Seller'>());
    const accepted = await request.execute(anonymous(), { sellerIds: hundred });
    expect(accepted.ok && accepted.value.size).toBe(100);

    const duplicates = Array.from({ length: 101 }, () => hundred[0] as string);
    for (const [sellerIds, fieldCode] of [
      [[...hundred, ids.next<'Seller'>()], 'length'],
      [duplicates, 'length'],
      [['not-an-id'], 'format'],
      [[42 as unknown as string], 'format'],
    ] as const) {
      for (const useCase of [request, jobs]) {
        const refused = await useCase.execute(useCase === request ? anonymous() : system(), {
          sellerIds,
        });
        expect(refused).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: fieldCode }] },
        });
      }
    }
  });

  it('gives byte-identical answers to every caller, an issued id and a never-issued one alike', async () => {
    const batch = [
      ids.next<'Seller'>(),
      '0197f2a0-0000-7000-8000-000000000000',
      ids.next<'Seller'>(),
    ];
    const bytes = (r: { ok: boolean; value?: ReadonlyMap<string, unknown> }) =>
      JSON.stringify(r.ok ? [...(r.value ?? [])] : r);

    const fromRequest = await facade.approvedSellerZones(anonymous(), batch as never);
    const fromJob = await facade.approvedSellerZones(system(), batch as never);

    expect(fromRequest.ok && fromJob.ok).toBe(true);
    expect(bytes(fromJob as never)).toBe(bytes(fromRequest as never));
  });

  it('keeps each case to its own actor kind (the facade picks the pair)', async () => {
    const a = ids.next<'Seller'>();

    expect((await jobs.execute(anonymous(), { sellerIds: [a] })).ok).toBe(false);
    expect((await request.execute(system(), { sellerIds: [a] })).ok).toBe(false);
  });
});

it('answers the same bytes under AU and ZZ', async () => {
  const request = new ApprovedSellerZones(gate);
  const a = ids.next<'Seller'>();

  const au = await request.execute(
    testCallContext(testMarketContext('AU', 'default'), 'anonymous'),
    { sellerIds: [a] },
  );
  const zz = await request.execute(
    testCallContext(testMarketContext('ZZ', 'default'), 'anonymous'),
    { sellerIds: [a] },
  );

  expect(JSON.stringify([...(au.ok ? au.value : [])])).toBe(
    JSON.stringify([...(zz.ok ? zz.value : [])]),
  );
});
