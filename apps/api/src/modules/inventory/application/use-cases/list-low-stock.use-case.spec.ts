import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { LowStockPage, LowStockSignal, OfferStockReader } from '../ports/offer-stock.reader';
import type { SellUnitLabel, SellUnitLabelsSource } from '../ports/sell-unit-labels';
import { ListLowStock } from './list-low-stock.use-case';

// `inventory.list-low-stock` in memory on both Market fixtures. The query itself (seller and
// Market scope, order, cursor, retired items) is in test/db/inventory-low-stock.db-spec.ts.

const START = Temporal.Instant.from('2026-10-16T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const key = (s: { offerId: string; variantId: string }) => `${s.offerId}:${s.variantId}`;

class FakeReader implements OfferStockReader {
  signals: LowStockSignal[] = [];
  retired = new Set<string>();
  pages: { sellerId: Id<'Seller'>; status: 'low' | 'out' | null; page: LowStockPage }[] = [];
  read() {
    return Promise.reject(new Error('not used'));
  }
  listLowStock(
    _m: MarketContext,
    sellerId: Id<'Seller'>,
    status: 'low' | 'out' | null,
    page: LowStockPage,
  ) {
    this.pages.push({ sellerId, status, page });
    return Promise.resolve(
      this.signals.filter((s) => status === null || s.status === status).slice(0, page.limit),
    );
  }
  liveSellUnits(
    _m: MarketContext,
    _s: Id<'Seller'>,
    keys: readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'> }[],
  ) {
    return Promise.resolve(new Set(keys.map(key).filter((k) => !this.retired.has(k))));
  }
}

class FakeLabels implements SellUnitLabelsSource {
  labels = new Map<string, SellUnitLabel>();
  fail = false;
  calls = 0;
  labelsOf() {
    this.calls += 1;
    return this.fail ? Promise.reject(new Error('down')) : Promise.resolve(this.labels);
  }
}

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const offerStock = new FakeReader();
  const labels = new FakeLabels();
  const units: UnitOfWorkOptions[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      o: UnitOfWorkOptions = {},
    ) => {
      units.push(o);
      return work();
    },
    runOnce: () => Promise.reject(new Error('not used')),
  };
  const list = new ListLowStock(gate, { unitOfWork, offerStock, labels });
  return { ids, offerStock, labels, units, list };
}

describe.each(['AU', 'ZZ'] as const)('inventory.list-low-stock in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function seller(t: ReturnType<typeof setUp>) {
    const sellerId = t.ids.next<'Seller'>();
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId,
      }),
    );
    return { sellerId, context };
  }

  function signal(
    t: ReturnType<typeof setUp>,
    status: 'low' | 'out',
    minutesAgo: number,
  ): LowStockSignal {
    return {
      id: t.ids.next<'AvailabilitySignal'>(),
      offerId: t.ids.next<'Offer'>(),
      variantId: t.ids.next<'Variant'>(),
      status,
      onlyLeft: status === 'low' ? 3 : null,
      changedAt: START.subtract({ minutes: minutesAgo }),
    };
  }

  it('lists the seller’s low and out sell units with their names, in one read-only unit', async () => {
    const t = setUp();
    const { sellerId, context } = seller(t);
    const low = signal(t, 'low', 1);
    const out = signal(t, 'out', 2);
    t.offerStock.signals = [low, out];
    t.labels.labels.set(key(low), { productName: 'Dates', variantLabel: '500 g' });

    const result = await t.list.execute(context, {});

    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            offerId: low.offerId,
            variantId: low.variantId,
            status: 'low',
            onlyLeft: 3,
            changedAt: low.changedAt,
            productName: 'Dates',
            variantLabel: '500 g',
          },
          {
            offerId: out.offerId,
            variantId: out.variantId,
            status: 'out',
            onlyLeft: null,
            changedAt: out.changedAt,
            productName: null,
            variantLabel: null,
          },
        ],
        nextCursor: null,
      },
    });
    expect(t.offerStock.pages).toEqual([
      { sellerId, status: null, page: { limit: 26, after: null } },
    ]);
    expect(t.units).toEqual([{ readOnly: true }]);
    expect(t.labels.calls).toBe(1);
  });

  it('keeps one status, leaves out retired sell units and pages with a cursor', async () => {
    const t = setUp();
    const { context } = seller(t);
    const [a, b, c] = [signal(t, 'out', 1), signal(t, 'out', 2), signal(t, 'out', 3)];
    t.offerStock.signals = [a, b, c, signal(t, 'low', 4)];
    t.offerStock.retired.add(key(b));

    const first = await t.list.execute(context, { status: 'out', limit: 2 });
    expect(first.ok && first.value.items.map((item) => item.offerId)).toEqual([a.offerId]);
    const cursor = first.ok ? first.value.nextCursor : null;
    expect(cursor).toBe(`${b.changedAt.epochMilliseconds}.${b.id}`);

    await t.list.execute(context, { status: 'out', limit: 2, cursor });
    expect(t.offerStock.pages[1]).toMatchObject({
      status: 'out',
      page: { limit: 3, after: { changedAt: b.changedAt, id: b.id } },
    });
  });

  it('answers without names when the catalog lookup fails', async () => {
    const t = setUp();
    const { context } = seller(t);
    t.offerStock.signals = [signal(t, 'low', 1)];
    t.labels.fail = true;

    const result = await t.list.execute(context, {});

    expect(result.ok && result.value.items[0]?.productName).toBeNull();
  });

  it('skips the catalog call for an empty page', async () => {
    const t = setUp();
    const { context } = seller(t);
    const result = await t.list.execute(context, {});
    expect(result).toEqual({ ok: true, value: { items: [], nextCursor: null } });
    expect(t.labels.calls).toBe(0);
  });

  it('refuses a bad status, limit or cursor before reading', async () => {
    const t = setUp();
    const { context } = seller(t);
    const result = await t.list.execute(context, { status: 'in-stock', limit: 0, cursor: 'x' });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'status', code: 'value' },
          { path: 'limit', code: 'range' },
          { path: 'cursor', code: 'format' },
        ],
      },
    });
    expect(t.units).toEqual([]);
  });

  it('refuses a caller that is not a seller', async () => {
    const t = setUp();
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const result = await t.list.execute(context, {});
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
  });
});
