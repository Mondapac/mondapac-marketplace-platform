import { parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../../test/support/pricing-fakes';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AvailabilityItem } from '../ports/availability-reader';
import { AvailabilitySystemQuery } from './availability-system.use-case';
import { AvailabilityQuery } from './availability.use-case';

// `inventory.availability` in memory on both Market fixtures: the largest sellable of the
// sources, the stored low status, and "out" for a sell unit with no stock.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true }),
});
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OFFER = id<'Offer'>(1);
const VARIANT = id<'Variant'>(2);
const OTHER = id<'Variant'>(3);

describe.each(['AU', 'ZZ'] as const)('inventory.availability in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const buyer = testCallContext(market, 'anonymous', 'inv-0001-abcd');

  function setup(items: AvailabilityItem[], lowFor: string[] = []) {
    const unitOfWork = new FakeUnitOfWork();
    const deps = {
      unitOfWork,
      items: { itemsOfSellUnits: () => Promise.resolve(items) },
      signals: {
        find: (_m: MarketContext, offerId: string, variantId: string) =>
          Promise.resolve(
            lowFor.includes(`${offerId}/${variantId}`)
              ? { id: id<'AvailabilitySignal'>(9), status: 'low' as const, onlyLeft: 3, version: 1 }
              : null,
          ),
      },
    } as never;
    return {
      query: new AvailabilityQuery(gate, deps),
      system: new AvailabilitySystemQuery(gate, deps),
      unitOfWork,
    };
  }
  const keys = [
    { offerId: OFFER, variantId: VARIANT },
    { offerId: OFFER, variantId: OTHER },
  ];

  it('takes the largest sellable source, reports low from the signal and out for no stock', async () => {
    const { query } = setup(
      [
        { offerId: OFFER, variantId: VARIANT, onHand: 3, held: 0 },
        { offerId: OFFER, variantId: VARIANT, onHand: 8, held: 5 },
      ],
      [`${OFFER}/${VARIANT}`],
    );

    const result = await query.execute(buyer, { keys });

    if (!result.ok) throw new Error('expected ok');
    expect(result.value.get(`${OFFER}/${VARIANT}`)).toEqual({
      sellable: 3,
      status: 'low',
      onlyLeft: 3,
    });
    expect(result.value.get(`${OFFER}/${OTHER}`)).toEqual({
      sellable: 0,
      status: 'out',
      onlyLeft: null,
    });
  });

  it('treats everything held as out and an unmarked sell unit as in stock', async () => {
    const { query } = setup([
      { offerId: OFFER, variantId: VARIANT, onHand: 4, held: 4 },
      { offerId: OFFER, variantId: OTHER, onHand: 50, held: 0 },
    ]);

    const result = await query.execute(buyer, { keys });

    if (!result.ok) throw new Error('expected ok');
    expect(result.value.get(`${OFFER}/${VARIANT}`)?.status).toBe('out');
    expect(result.value.get(`${OFFER}/${OTHER}`)).toEqual({
      sellable: 50,
      status: 'in-stock',
      onlyLeft: null,
    });
  });

  it('refuses a malformed key and more than 200 keys whole, before any read', async () => {
    const { query, unitOfWork } = setup([]);

    expect(await query.execute(buyer, { keys: [{ offerId: 'x', variantId: 'y' }] })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'keys', code: 'format' }] },
    });
    expect(
      await query.execute(buyer, { keys: Array.from({ length: 201 }, () => keys[0]!) }),
    ).toEqual({
      ok: false,
      error: { code: 'batch.too-large' },
    });
    expect(unitOfWork.units).toHaveLength(0);
  });

  it('answers the system actor through the pair in a read-only unit', async () => {
    const { system, unitOfWork } = setup([
      { offerId: OFFER, variantId: VARIANT, onHand: 2, held: 0 },
    ]);

    const result = await system.execute(testCallContext(market, 'system', 'inv-0002-abcd'), {
      keys,
    });

    expect(result.ok).toBe(true);
    expect(unitOfWork.units[0]?.options).toEqual({ readOnly: true });
  });
});
