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
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerInventory } from '../../domain/seller-inventory';
import type { OfferSellUnitsSource, StockOfferView } from '../ports/offer-sell-units';
import type { OfferStockReader, OfferStockSnapshot } from '../ports/offer-stock.reader';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import { ViewOfferStock } from './view-offer-stock.use-case';

// `inventory.view-offer-stock` in memory on both Market fixtures. The query itself (held sum,
// tombstones, the market scope) is in test/db/inventory-view-offer-stock.db-spec.ts.

const START = Temporal.Instant.from('2026-10-09T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

class FakeInventories implements SellerInventoryRepository {
  readonly stored = new Map<string, SellerInventory>();
  add(market: MarketContext, inventory: SellerInventory): Promise<boolean> {
    this.stored.set(`${market.marketId}|${inventory.state.sellerId}`, inventory);
    return Promise.resolve(true);
  }
  findBySeller(market: MarketContext, sellerId: Id<'Seller'>) {
    const found = this.stored.get(`${market.marketId}|${sellerId}`);
    return Promise.resolve(found === undefined ? null : SellerInventory.fromStored(found.state));
  }
  save(): Promise<'saved' | 'stale'> {
    return Promise.reject(new Error('not used'));
  }
}

class FakeReader implements OfferStockReader {
  snapshot: OfferStockSnapshot = {
    offerRetired: false,
    retiredVariantIds: new Set(),
    items: [],
  };
  calls = 0;
  read() {
    this.calls += 1;
    return Promise.resolve(this.snapshot);
  }
}

class FakeOffers implements OfferSellUnitsSource {
  readonly offers = new Map<Id<'Offer'>, StockOfferView>();
  sellUnitsOf(_c: CallContext, offerIds: readonly Id<'Offer'>[]) {
    const answer = new Map<Id<'Offer'>, StockOfferView>();
    for (const id of offerIds) {
      const offer = this.offers.get(id);
      if (offer !== undefined) answer.set(id, offer);
    }
    return Promise.resolve(answer);
  }
}

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const inventories = new FakeInventories();
  const offerStock = new FakeReader();
  const offers = new FakeOffers();
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
  const view = new ViewOfferStock(gate, { unitOfWork, inventories, offerStock, offers, clock });
  return { ids, inventories, offerStock, offers, units, view };
}
type T = ReturnType<typeof setUp>;

describe.each(['AU', 'ZZ'] as const)('inventory.view-offer-stock in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** A ready seller with two sources and an Offer of two Variants. */
  function world(t: T) {
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
    const base = SellerInventory.createWithDefaultSource({
      id: t.ids.next<'SellerInventory'>(),
      defaultSourceId: t.ids.next<'InventorySource'>(),
      sellerId,
      marketId: market.marketId,
      now: START,
    });
    const second = t.ids.next<'InventorySource'>();
    const first = base.state.sources[0]!;
    const inventory = SellerInventory.fromStored({
      ...base.state,
      sources: [...base.state.sources, { ...first, id: second, isDefault: false, priority: 2 }],
    });
    void t.inventories.add(market, inventory);
    const offerId = t.ids.next<'Offer'>();
    const variantA = t.ids.next<'Variant'>();
    const variantB = t.ids.next<'Variant'>();
    t.offers.offers.set(offerId, {
      sellerId,
      deleted: false,
      productId: t.ids.next<'Product'>(),
      sellUnitVariantIds: new Set([variantB, variantA]),
    });
    return { sellerId, context, offerId, variantA, variantB, source1: first.id, source2: second, t };
  }

  it('declares inventory.stock.view, denied for an unapproved seller', () => {
    expect(ViewOfferStock.access).toMatchObject({
      name: 'inventory.view-offer-stock',
      rule: { kind: 'permissions', allOf: ['inventory.stock.view'] },
      whenSellerNotApproved: 'deny',
    });
  });

  it('lists every Variant at every source, zero and null version where no item exists', async () => {
    const t = setUp();
    const w = world(t);
    t.offerStock.snapshot = {
      offerRetired: false,
      retiredVariantIds: new Set(),
      items: [
        {
          id: t.ids.next<'StockItem'>(),
          variantId: w.variantA,
          sourceId: w.source2,
          onHand: 9,
          version: 3,
          retired: false,
          held: 4,
        },
      ],
    };

    const result = await t.view.execute(w.context, { offerId: w.offerId });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.offerId).toBe(w.offerId);
    expect(result.value.variants.map((v) => v.variantId)).toEqual([w.variantA, w.variantB].sort());
    const cells = result.value.variants.flatMap((v) => v.sources);
    expect(cells).toHaveLength(4);
    expect(cells.find((c) => c.variantId === w.variantA && c.sourceId === w.source2)).toEqual({
      variantId: w.variantA,
      sourceId: w.source2,
      onHand: 9,
      held: 4,
      version: 3,
      retired: false,
    });
    expect(cells.find((c) => c.variantId === w.variantB && c.sourceId === w.source1)).toEqual({
      variantId: w.variantB,
      sourceId: w.source1,
      onHand: 0,
      held: 0,
      version: null,
      retired: false,
    });
    const first = result.value.variants[0]!.sources.map((s) => s.sourceId);
    expect(first).toEqual([w.source1, w.source2]);
  });

  it('opens one read-only unit and no other', async () => {
    const t = setUp();
    const w = world(t);

    await t.view.execute(w.context, { offerId: w.offerId });

    expect(t.units).toEqual([{ readOnly: true }]);
  });

  it('leaves out a Variant a tombstone covers and answers not found for a retired Offer', async () => {
    const t = setUp();
    const w = world(t);
    t.offerStock.snapshot = {
      offerRetired: false,
      retiredVariantIds: new Set([w.variantA]),
      items: [],
    };
    const some = await t.view.execute(w.context, { offerId: w.offerId });
    expect(some.ok && some.value.variants.map((v) => v.variantId)).toEqual([w.variantB]);

    t.offerStock.snapshot = { offerRetired: true, retiredVariantIds: new Set(), items: [] };
    expect(await t.view.execute(w.context, { offerId: w.offerId })).toEqual({
      ok: false,
      error: { code: 'inventory.not-found' },
    });
  });

  it('answers the same not found for an unknown, foreign or deleted Offer, without reading stock', async () => {
    const t = setUp();
    const w = world(t);
    const foreign = t.ids.next<'Offer'>();
    t.offers.offers.set(foreign, {
      sellerId: t.ids.next<'Seller'>(),
      deleted: false,
      productId: t.ids.next<'Product'>(),
      sellUnitVariantIds: new Set(),
    });
    const deleted = t.ids.next<'Offer'>();
    t.offers.offers.set(deleted, {
      sellerId: w.sellerId,
      deleted: true,
      productId: t.ids.next<'Product'>(),
      sellUnitVariantIds: new Set(),
    });

    for (const offerId of [t.ids.next<'Offer'>(), foreign, deleted]) {
      expect(await t.view.execute(w.context, { offerId })).toEqual({
        ok: false,
        error: { code: 'inventory.not-found' },
      });
    }
    expect(t.offerStock.calls).toBe(0);
  });

  it('refuses a malformed id, a seller without inventory and a non-seller actor', async () => {
    const t = setUp();
    const w = world(t);
    expect(await t.view.execute(w.context, { offerId: 'nope' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] },
    });

    t.inventories.stored.clear();
    expect(await t.view.execute(w.context, { offerId: w.offerId })).toEqual({
      ok: false,
      error: { code: 'inventory.not-ready' },
    });

    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    expect(await t.view.execute(customer, { offerId: w.offerId })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});
