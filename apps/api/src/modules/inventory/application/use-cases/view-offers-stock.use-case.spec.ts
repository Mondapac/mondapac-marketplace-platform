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
import { SellerInventory } from '../../domain/seller-inventory';
import type { OfferSellUnitsSource, StockOfferView } from '../ports/offer-sell-units';
import type { OfferStockReader, OfferStockSnapshot } from '../ports/offer-stock.reader';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import { MAX_LIST_OFFERS, ViewOffersStock } from './view-offers-stock.use-case';

// `inventory.view-offers-stock` (Offer page PR 8) in memory on both Market fixtures. The query of
// `readMany` is in test/db/inventory-view-offers-stock.db-spec.ts.

const START = Temporal.Instant.from('2026-11-25T01:00:00Z');
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
  readonly snapshots = new Map<Id<'Offer'>, OfferStockSnapshot>();
  asked: { offerId: Id<'Offer'>; variantIds: readonly Id<'Variant'>[] }[] = [];
  calls = 0;
  read() {
    return Promise.reject(new Error('not used'));
  }
  readMany(
    _m: MarketContext,
    _s: Id<'Seller'>,
    offers: readonly { offerId: Id<'Offer'>; variantIds: readonly Id<'Variant'>[] }[],
  ) {
    this.calls += 1;
    this.asked = [...offers];
    const answer = new Map<Id<'Offer'>, OfferStockSnapshot>();
    for (const offer of offers) {
      answer.set(
        offer.offerId,
        this.snapshots.get(offer.offerId) ?? {
          offerRetired: false,
          retiredVariantIds: new Set(),
          items: [],
        },
      );
    }
    return Promise.resolve(answer);
  }
  listLowStock() {
    return Promise.reject(new Error('not used'));
  }
  liveSellUnits() {
    return Promise.reject(new Error('not used'));
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
  const view = new ViewOffersStock(gate, { unitOfWork, inventories, offerStock, offers, clock });
  return { ids, inventories, offerStock, offers, units, view };
}
type T = ReturnType<typeof setUp>;

describe.each(['AU', 'ZZ'] as const)('inventory.view-offers-stock in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** A seller (ready unless `ready` is false) with one source. */
  function world(t: T, ready = true) {
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
    const inventory = SellerInventory.createWithDefaultSource({
      id: t.ids.next<'SellerInventory'>(),
      defaultSourceId: t.ids.next<'InventorySource'>(),
      sellerId,
      marketId: market.marketId,
      now: START,
    });
    if (ready) void t.inventories.add(market, inventory);
    const offer = (seller: Id<'Seller'>, variants: number, deleted = false) => {
      const offerId = t.ids.next<'Offer'>();
      const variantIds = Array.from({ length: variants }, () => t.ids.next<'Variant'>());
      t.offers.offers.set(offerId, {
        sellerId: seller,
        deleted,
        productId: t.ids.next<'Product'>(),
        sellUnitVariantIds: new Set(variantIds),
      });
      return { offerId, variantIds };
    };
    return { sellerId, context, offer, source: inventory.state.sources[0]!.id };
  }

  it('declares inventory.stock.view, denied for an unapproved seller', () => {
    expect(ViewOffersStock.access).toMatchObject({
      name: 'inventory.view-offers-stock',
      rule: { kind: 'permissions', allOf: ['inventory.stock.view'] },
      whenSellerNotApproved: 'deny',
    });
  });

  it('answers every own Offer in one read-only unit and one reader call, in the asked order', async () => {
    const t = setUp();
    const w = world(t);
    const a = w.offer(w.sellerId, 1);
    const b = w.offer(w.sellerId, 2);
    t.offerStock.snapshots.set(a.offerId, {
      offerRetired: false,
      retiredVariantIds: new Set(),
      items: [
        {
          id: t.ids.next<'StockItem'>(),
          variantId: a.variantIds[0]!,
          sourceId: w.source,
          onHand: 25,
          version: 3,
          retired: false,
          held: 2,
        },
      ],
    });

    const result = await t.view.execute(w.context, { offerIds: `${b.offerId},${a.offerId}` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(t.units).toEqual([{ readOnly: true }]);
    expect(t.offerStock.calls).toBe(1);
    expect(result.value.offers.map((offer) => offer.offerId)).toEqual([b.offerId, a.offerId]);
    expect(result.value.offers[0]?.variants).toHaveLength(2);
    expect(result.value.offers[1]?.variants).toEqual([
      {
        variantId: a.variantIds[0],
        sources: [
          {
            variantId: a.variantIds[0],
            sourceId: w.source,
            onHand: 25,
            held: 2,
            version: 3,
            retired: false,
          },
        ],
      },
    ]);
  });

  it('gives zero and a null version where a sell unit has no item, and drops retired ones', async () => {
    const t = setUp();
    const w = world(t);
    const a = w.offer(w.sellerId, 2);
    const retiredOffer = w.offer(w.sellerId, 1);
    t.offerStock.snapshots.set(a.offerId, {
      offerRetired: false,
      retiredVariantIds: new Set([a.variantIds[1]!]),
      items: [],
    });
    t.offerStock.snapshots.set(retiredOffer.offerId, {
      offerRetired: true,
      retiredVariantIds: new Set(),
      items: [],
    });

    const result = await t.view.execute(w.context, {
      offerIds: `${a.offerId},${retiredOffer.offerId}`,
    });

    expect(result.ok && result.value.offers).toEqual([
      {
        offerId: a.offerId,
        variants: [
          {
            variantId: a.variantIds[0],
            sources: [
              {
                variantId: a.variantIds[0],
                sourceId: w.source,
                onHand: 0,
                held: 0,
                version: null,
                retired: false,
              },
            ],
          },
        ],
      },
    ]);
  });

  it("leaves out another seller's, a deleted and an unknown Offer and never reads them", async () => {
    const t = setUp();
    const w = world(t);
    const mine = w.offer(w.sellerId, 1);
    const theirs = w.offer(t.ids.next<'Seller'>(), 1);
    const gone = w.offer(w.sellerId, 1, true);

    const result = await t.view.execute(w.context, {
      offerIds: [theirs.offerId, mine.offerId, gone.offerId, t.ids.next<'Offer'>()].join(','),
    });

    expect(result.ok && result.value.offers.map((offer) => offer.offerId)).toEqual([mine.offerId]);
    expect(t.offerStock.asked.map((offer) => offer.offerId)).toEqual([mine.offerId]);
  });

  it('answers inventory.not-ready for a seller with no inventory yet', async () => {
    const t = setUp();
    const w = world(t, false);
    const mine = w.offer(w.sellerId, 1);

    const result = await t.view.execute(w.context, { offerIds: mine.offerId });

    expect(result).toEqual({ ok: false, error: { code: 'inventory.not-ready' } });
  });

  it.each([
    ['nothing', undefined],
    ['an empty list', ''],
    ['a non-UUID', 'x'],
  ])('refuses %s as offerIds', async (_name, offerIds) => {
    const t = setUp();
    const w = world(t);

    const result = await t.view.execute(w.context, { offerIds });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('validation.failed');
    expect(t.offerStock.calls).toBe(0);
  });

  it('refuses a repeated id and more than the largest list page, takes exactly the largest', async () => {
    const t = setUp();
    const w = world(t);
    const mine = w.offer(w.sellerId, 1);
    const page = Array.from({ length: MAX_LIST_OFFERS }, () => t.ids.next<'Offer'>());

    const repeated = await t.view.execute(w.context, {
      offerIds: `${mine.offerId},${mine.offerId}`,
    });
    const long = await t.view.execute(w.context, {
      offerIds: [...page, mine.offerId].join(','),
    });
    const full = await t.view.execute(w.context, { offerIds: page.join(',') });

    expect(repeated.ok).toBe(false);
    expect(long.ok).toBe(false);
    expect(full).toEqual({ ok: true, value: { offers: [] } });
  });
});
