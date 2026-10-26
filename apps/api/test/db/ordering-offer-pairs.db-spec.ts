import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { BoughtTogetherQuery } from '../../src/modules/ordering/application/use-cases/bought-together.use-case';
import { RebuildOfferPairs } from '../../src/modules/ordering/application/use-cases/rebuild-offer-pairs.use-case';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { PrismaOfferPairStore } from '../../src/modules/ordering/infrastructure/prisma-offer-pairs.store';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// "Bought together" on PostgreSQL (ordering.offer_pairs), as the application role, in both Market
// fixtures: the nightly rebuild counts distinct buyer accounts (one paid, confirmed order each, by
// confirmation time) over 90 days and keeps pairs of 3 or more, stores both directions, never mixes Markets, replaces the
// old table in full and gives the same table when run again; the read answers Offer ids by buyers
// then id; the CHECKs and the grants (select, insert, delete only) hold.

const NOW = Temporal.Instant.from('2026-10-25T03:00:00Z');
const SINCE = NOW.subtract({ hours: 90 * 24 });
const CHECK = '23514';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('offer pairs in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = (target: MarketContext) => (target.marketId === 'AU' ? 'AUD' : 'JPY');
  const clock = new FixedClock(NOW);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = (target: MarketContext) =>
    testCallContext(target, 'system', 'pairs-db-system-abc');
  const anonymous = (target: MarketContext) =>
    testCallContext(target, 'anonymous', 'pairs-db-anon-abcd');
  let db: Persistence;
  let orders: PrismaOrderRepository;
  let store: PrismaOfferPairStore;
  let rebuild: RebuildOfferPairs;
  let query: BoughtTogetherQuery;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    orders = new PrismaOrderRepository(db.service);
    store = new PrismaOfferPairStore(db.service);
    rebuild = new RebuildOfferPairs(gate, { unitOfWork: db.unitOfWork, pairs: store, clock });
    query = new BoughtTogetherQuery(gate, { unitOfWork: db.unitOfWork, pairs: store });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  type Kind = 'confirmed' | 'pending' | 'cancelled';
  /** One order of the Market with one line per given Offer (one seller order). */
  const order = (
    target: MarketContext,
    offers: readonly Id<'Offer'>[],
    kind: Kind = 'confirmed',
    confirmedAt: Temporal.Instant = NOW.subtract({ hours: 24 }),
    accountId: Id<'Account'> = ids.next<'Account'>(),
  ): OrderState => {
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    return {
      id: orderId,
      marketId: target.marketId,
      accountId,
      status:
        kind === 'confirmed' ? 'confirmed' : kind === 'cancelled' ? 'cancelled' : 'pending-payment',
      cancelReason: kind === 'cancelled' ? 'expired' : null,
      paymentState: kind === 'confirmed' ? 'captured' : 'none',
      total: money(1000n * BigInt(offers.length), currency(target)),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: null,
      stripePaymentIntentId: kind === 'confirmed' ? `pi_test_${orderId}` : null,
      paymentExpiresAt: NOW.add({ minutes: 30 }),
      createdAt: NOW.subtract({ hours: 48 }),
      confirmedAt: kind === 'confirmed' ? confirmedAt : null,
      cancelledAt: kind === 'cancelled' ? NOW.subtract({ hours: 24 }) : null,
      version: 1,
      taxStrategyId: ids.next<'TaxStrategy'>(),
      shipToSealed: `v1.ship-to-of-${orderId}`,
      sellerOrders: [
        {
          id: sellerOrderId,
          sellerId: ids.next<'Seller'>(),
          subtotal: 1000n * BigInt(offers.length),
          shipping: 0n,
          shippingTaxRateBps: null,
          shippingTax: null,
          shippingTaxInclusive: null,
          total: 1000n * BigInt(offers.length),
          fulfilment: 'to-ship',
          carrier: null,
          trackingRef: null,
          shippedAt: null,
          deliveredAt: null,
          inventoryRecordedAt: null,
          ledgerState: 'pending',
          deliveryMethod: 'instant',
          deliveryWindow: null,
          readyAt: null,
          deliveryAttention: null,
        },
      ],
      lines: offers.map((offerId) => ({
        id: ids.next<'OrderLine'>(),
        sellerOrderId,
        offerId,
        variantId: ids.next<'Variant'>(),
        quantity: 1,
        unitPrice: money(1000n, currency(target)),
        lineAmount: 1000n,
        taxInclusive: true,
        reservationLineId: ids.next<'ReservationLine'>(),
        commissionRateBps: 1500,
        taxRateBps: 1000,
        taxAmount: 91n,
        taxCategoryCode: 'taxable',
      })),
    };
  };
  const place = async (target: MarketContext, ...placed: OrderState[]) => {
    for (const o of placed) await value(target, () => orders.insert(target, o));
  };
  const times = (n: number, make: () => OrderState) => Array.from({ length: n }, make);
  const offer = () => ids.next<'Offer'>();

  const run = async (target: MarketContext = market) => {
    const result = await rebuild.execute(system(target), {});
    if (!result.ok) throw new Error('rebuild refused');
    return result.value;
  };
  const pairsOf = async (target: MarketContext, offerId: string) =>
    (
      await sql.query<{ paired: string; orders: number }>(
        `SELECT paired_offer_id AS paired, orders FROM ordering.offer_pairs
          WHERE market_id = $1 AND offer_id = $2 ORDER BY orders DESC, paired_offer_id`,
        [target.marketId, offerId],
      )
    ).rows;
  const asked = async (target: MarketContext, offerId: Id<'Offer'>, limit = 24) => {
    const result = await query.execute(anonymous(target), { offerId, limit });
    if (!result.ok) throw new Error('query refused');
    return result.value;
  };

  it('keeps a pair of 3 distinct buyers in both directions and drops one of 2 buyers', async () => {
    const [a, b, c, d] = [offer(), offer(), offer(), offer()] as const;
    await place(
      market,
      ...times(3, () => order(market, [a, b])),
      ...times(2, () => order(market, [c, d])),
    );

    await run();

    expect(await pairsOf(market, a)).toEqual([{ paired: b, orders: 3 }]);
    expect(await pairsOf(market, b)).toEqual([{ paired: a, orders: 3 }]);
    expect(await pairsOf(market, c)).toEqual([]);
    expect(await pairsOf(market, d)).toEqual([]);
  });

  it('makes no pair of 3 orders from one account, and counts an account once across its orders', async () => {
    const [a, b, c, d, e, f] = [offer(), offer(), offer(), offer(), offer(), offer()] as const;
    const one = ids.next<'Account'>();
    const two = ids.next<'Account'>();
    const when = NOW.subtract({ hours: 24 });
    await place(
      market,
      // one account, three orders: no pair
      ...times(3, () => order(market, [a, b], 'confirmed', when, one)),
      // two accounts, five orders: no pair
      ...times(3, () => order(market, [c, d], 'confirmed', when, one)),
      ...times(2, () => order(market, [c, d], 'confirmed', when, two)),
      // three accounts, one of them with two orders: a pair of 3 buyers, not 4 orders
      order(market, [e, f], 'confirmed', when, one),
      order(market, [e, f], 'confirmed', when, one),
      order(market, [e, f], 'confirmed', when, two),
      order(market, [e, f]),
    );

    await run();

    expect(await pairsOf(market, a)).toEqual([]);
    expect(await pairsOf(market, c)).toEqual([]);
    expect(await pairsOf(market, e)).toEqual([{ paired: f, orders: 3 }]);
    expect(await pairsOf(market, f)).toEqual([{ paired: e, orders: 3 }]);
  });

  it('counts an order once however many lines hold the Offers', async () => {
    const [a, b] = [offer(), offer()] as const;
    await place(
      market,
      order(market, [a, a, b, b]),
      order(market, [a, b]),
      order(market, [b, a, a]),
    );

    await run();

    expect(await pairsOf(market, a)).toEqual([{ paired: b, orders: 3 }]);
  });

  it('counts only confirmed orders: pending and cancelled ones do not make a pair', async () => {
    const [a, b] = [offer(), offer()] as const;
    await place(
      market,
      order(market, [a, b]),
      order(market, [a, b]),
      order(market, [a, b], 'pending'),
      order(market, [a, b], 'cancelled'),
    );

    await run();

    expect(await pairsOf(market, a)).toEqual([]);
  });

  it('counts by confirmation time over 90 days: the edge instant is in, a moment before is out', async () => {
    const [a, b, c, d] = [offer(), offer(), offer(), offer()] as const;
    await place(
      market,
      // exactly 90 days before now: counted
      order(market, [a, b], 'confirmed', SINCE),
      order(market, [a, b], 'confirmed', SINCE.add({ milliseconds: 1 })),
      order(market, [a, b], 'confirmed', NOW),
      // one millisecond older: not counted
      order(market, [c, d], 'confirmed', SINCE.subtract({ milliseconds: 1 })),
      order(market, [c, d], 'confirmed', SINCE),
      order(market, [c, d], 'confirmed', SINCE.add({ hours: 24 })),
    );

    await run();

    expect(await pairsOf(market, a)).toEqual([{ paired: b, orders: 3 }]);
    expect(await pairsOf(market, c)).toEqual([]);
  });

  it('counts a pair inside a larger order, and every pair of it', async () => {
    const [a, b, c] = [offer(), offer(), offer()] as const;
    await place(market, ...times(3, () => order(market, [a, b, c])));

    await run();

    expect(await pairsOf(market, a)).toEqual(
      [b, c].sort().map((paired) => ({ paired, orders: 3 })),
    );
    expect(await pairsOf(market, c)).toEqual(
      [a, b].sort().map((paired) => ({ paired, orders: 3 })),
    );
  });

  it('keeps each Market apart: orders of the other Market add nothing and its table is untouched', async () => {
    const [a, b] = [offer(), offer()] as const;
    await place(market, order(market, [a, b]), order(market, [a, b]));
    await place(other, order(other, [a, b]));
    await run();
    expect(await pairsOf(market, a)).toEqual([]);
    expect(await pairsOf(other, a)).toEqual([]);

    await place(other, ...times(2, () => order(other, [a, b])));
    await run(other);
    expect(await pairsOf(other, a)).toEqual([{ paired: b, orders: 3 }]);
    expect(await pairsOf(market, a)).toEqual([]);

    await place(market, order(market, [a, b]));
    await run(market);
    expect(await pairsOf(market, a)).toEqual([{ paired: b, orders: 3 }]);
    expect(await pairsOf(other, a)).toEqual([{ paired: b, orders: 3 }]);
    expect(await asked(market, a)).toEqual([b]);
    expect(await asked(other, a)).toEqual([b]);
  });

  it('replaces the whole table: a pair that fell out of the window or the threshold is gone', async () => {
    const [a, b, c] = [offer(), offer(), offer()] as const;
    await owner.query(
      `INSERT INTO ordering.offer_pairs VALUES ($1, 'default', $2, $3, 9, $4), ($1, 'default', $3, $2, 9, $4)`,
      [market.marketId, a, c, SINCE.toString()],
    );
    await place(market, ...times(3, () => order(market, [a, b])));

    const first = await run();

    expect(first.rows).toBeGreaterThanOrEqual(2);
    expect(await pairsOf(market, a)).toEqual([{ paired: b, orders: 3 }]);
    expect(await pairsOf(market, c)).toEqual([]);
    const stamps = await sql.query<{ computed_at: Date }>(
      'SELECT DISTINCT computed_at FROM ordering.offer_pairs WHERE market_id = $1',
      [market.marketId],
    );
    expect(stamps.rows.map((r) => r.computed_at.toISOString())).toEqual([
      NOW.toString().replace('Z', '.000Z'),
    ]);
  });

  it('is idempotent: a second run leaves the same pairs of this test', async () => {
    const [a, b, c] = [offer(), offer(), offer()] as const;
    await place(
      market,
      ...times(4, () => order(market, [a, b])),
      ...times(3, () => order(market, [b, c])),
    );
    const dump = async () =>
      (
        await sql.query<Record<string, unknown>>(
          `SELECT offer_id, paired_offer_id, orders, computed_at FROM ordering.offer_pairs
            WHERE market_id = $1 AND offer_id = ANY($2::uuid[]) ORDER BY offer_id, paired_offer_id`,
          [market.marketId, [a, b, c]],
        )
      ).rows;

    await run();
    const before = await dump();
    await run();

    expect(before).toHaveLength(4);
    expect(await dump()).toEqual(before);
    expect(await pairsOf(market, b)).toEqual([
      { paired: a, orders: 4 },
      { paired: c, orders: 3 },
    ]);
  });

  it('counts only orders confirmed at or before the Clock: now is in, one millisecond later is out', async () => {
    const [a, b, c, d] = [offer(), offer(), offer(), offer()] as const;
    await place(
      market,
      order(market, [a, b], 'confirmed', NOW),
      order(market, [a, b], 'confirmed', NOW.subtract({ milliseconds: 1 })),
      order(market, [a, b], 'confirmed', NOW.add({ milliseconds: 1 })),
      order(market, [c, d], 'confirmed', NOW),
      order(market, [c, d], 'confirmed', NOW.subtract({ milliseconds: 1 })),
      order(market, [c, d], 'confirmed', NOW.subtract({ hours: 1 })),
    );

    await run();

    expect(await pairsOf(market, a)).toEqual([]);
    expect(await pairsOf(market, c)).toEqual([{ paired: d, orders: 3 }]);
  });

  it('pages orders by (confirmed_at, id) without a gap or a repeat across equal times', async () => {
    const T = Temporal.Instant.from('2026-09-01T00:00:00Z');
    const at = [0, 0, 0, 1, 2].map((ms) => T.add({ milliseconds: ms }));
    const placed = at.map((when) => order(market, [offer(), offer()], 'confirmed', when));
    await place(market, ...placed);
    const window = { since: T, until: T.add({ milliseconds: 2 }) };
    const pages: string[][] = [];
    let after: { confirmedAt: Temporal.Instant; orderId: string } | null = null;
    for (;;) {
      const page = await value(market, () => store.confirmedOrders(market, window, after, 2));
      pages.push(page.orders.map((o) => o.orderId));
      const last = page.orders.at(-1);
      if (last === undefined || page.orders.length < 2) break;
      after = { confirmedAt: last.confirmedAt, orderId: last.orderId };
    }

    const expected = [...placed]
      .sort(
        (x, y) =>
          x.confirmedAt!.epochMilliseconds - y.confirmedAt!.epochMilliseconds ||
          (x.id < y.id ? -1 : 1),
      )
      .map((o) => o.id);
    expect(pages.flat()).toEqual(expected);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
  });

  it('leaves out an order with more than 20 distinct Offers', async () => {
    const [a, b] = [offer(), offer()] as const;
    const crowd = Array.from({ length: 19 }, () => offer());
    await place(market, ...times(3, () => order(market, [a, b, ...crowd, offer()])));

    const result = await run();

    expect(result.skippedLargeOrders).toBeGreaterThanOrEqual(3);
    expect(await pairsOf(market, a)).toEqual([]);
  });

  it('answers the partners most orders first, ties by Offer id, within the limit, ids only', async () => {
    const [a, x, y, z] = [offer(), offer(), offer(), offer()] as const;
    await place(
      market,
      ...times(5, () => order(market, [a, z])),
      ...times(3, () => order(market, [a, x])),
      ...times(3, () => order(market, [a, y])),
    );
    await run();

    const tied = [x, y].sort();
    expect(await asked(market, a)).toEqual([z, ...tied]);
    expect(await asked(market, a, 2)).toEqual([z, tied[0]]);
    expect(await asked(market, a, 1)).toEqual([z]);
    expect(await asked(market, offer())).toEqual([]);
    expect(await asked(other, a)).toEqual([]);
  });

  it('refuses a pair of an Offer with itself, fewer than 3 orders, and a bad scope', async () => {
    const [a, b] = [offer(), offer()] as const;
    const insert = (marketId: string, tenantId: string, first: string, second: string, n: number) =>
      owner.query(`INSERT INTO ordering.offer_pairs VALUES ($1, $2, $3, $4, $5, $6)`, [
        marketId,
        tenantId,
        first,
        second,
        n,
        NOW.toString(),
      ]);
    await expect(insert(market.marketId, 'default', a, a, 3)).rejects.toMatchObject({
      code: CHECK,
    });
    await expect(insert(market.marketId, 'default', a, b, 2)).rejects.toMatchObject({
      code: CHECK,
    });
    await expect(insert('au', 'default', a, b, 3)).rejects.toMatchObject({ code: CHECK });
    await expect(insert(market.marketId, 'Default', a, b, 3)).rejects.toMatchObject({
      code: CHECK,
    });
  });

  it('gives the application role select, insert and delete only, and no personal columns', async () => {
    const columns = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'ordering' AND table_name = 'offer_pairs' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      'market_id',
      'tenant_id',
      'offer_id',
      'paired_offer_id',
      'orders',
      'computed_at',
    ]);
    const [a, b] = [offer(), offer()] as const;
    await expect(
      sql.query(`UPDATE ordering.offer_pairs SET orders = 9 WHERE market_id = $1`, [
        market.marketId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql.query(`INSERT INTO ordering.offer_pairs VALUES ($1, 'default', $2, $3, 3, now())`, [
        market.marketId,
        a,
        b,
      ]),
    ).resolves.toBeDefined();
    await expect(sql.query(`TRUNCATE ordering.offer_pairs`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});
