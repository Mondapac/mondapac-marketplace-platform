import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { AdminListShipments } from '../../src/modules/ordering/application/use-cases/admin-list-shipments.use-case';
import type {
  ShipmentListFilter,
  ShipmentSort,
} from '../../src/modules/ordering/domain/admin-shipment-list';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { PrismaAdminShipmentListReader } from '../../src/modules/ordering/infrastructure/prisma-admin-shipment-list.reader';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { FakeCarrierProgress, FakeLabels } from '../support/ordering-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// The admin Shipments list on PostgreSQL, as the application role, for both Market fixtures: only
// paid orders' seller orders, the stages (to prepare, ready, shipped, delivered), the filters, the
// exact references (seller order, order, tracking), the search by customer or store, the sorts
// with their tie and the not-yet times last, the paging with its total, the row actions, and that
// another Market's shipments never show. Other files write orders into the same database at the
// same time, so every read here is scoped to this file's own sellers, and the per-stage counts are
// only compared with a lower bound.

const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const NO_FILTER: ShipmentListFilter = {
  ids: null,
  stage: null,
  reference: null,
  trackingRef: null,
  deliveryMethod: null,
  attention: null,
  fleet: null,
  sellerId: null,
  paidFrom: null,
  paidTo: null,
  shippedFrom: null,
  shippedTo: null,
  parties: null,
};
const NEWEST: ShipmentSort = { key: 'paid', direction: 'desc' };

type Stage = 'to-prepare' | 'ready' | 'shipped' | 'delivered';

describe.each(TEST_MARKETS)('admin shipment list in market %s (database)', (code) => {
  const market = marketOf(code);
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let orders: PrismaOrderRepository;
  let reader: PrismaAdminShipmentListReader;
  let admin: CallContext;

  beforeAll(() => {
    db = createPersistence();
    orders = new PrismaOrderRepository(db.service);
    reader = new PrismaAdminShipmentListReader(db.service);
    admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  });
  afterAll(() => db.close());

  /**
   * One order of one seller, paid at the clock's time unless `paid` is false, moved to `stage`;
   * the clock moves a minute after it.
   */
  const shipment = async (
    sellerId: Id<'Seller'>,
    stage: Stage,
    options: {
      paid?: boolean;
      accountId?: Id<'Account'>;
      method?: 'pickup' | 'instant';
      fleet?: string;
      total?: bigint;
      tracking?: string;
      attention?: 'no-carrier';
      /**
       * A delivery fee and its tax; the tax is outside the fee unless `inclusive`. A null tax is a
       * fee placed before its tax was recorded.
       */
      fee?: { amount: bigint; tax: bigint; inclusive: boolean } | { amount: bigint; tax: null };
      /** Keep the clock where it is, to pay several orders at one instant. */
      sameInstant?: boolean;
    } = {},
  ) => {
    const paid = options.paid ?? true;
    const now = clock.now();
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    const total = options.total ?? 1000n;
    // The goods: the total less the fee and any tax outside it.
    const subtotal =
      total -
      (options.fee?.amount ?? 0n) -
      (options.fee !== undefined && options.fee.tax !== null && !options.fee.inclusive
        ? options.fee.tax
        : 0n);
    const feeTax = options.fee !== undefined && options.fee.tax !== null ? options.fee : null;
    const order: OrderState = {
      id: orderId,
      marketId: market.marketId,
      accountId: options.accountId ?? ids.next<'Account'>(),
      status: paid ? 'confirmed' : 'pending-payment',
      cancelReason: null,
      paymentState: paid ? 'captured' : 'none',
      total: money(total, currency),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: `cs_${orderId.replaceAll('-', '')}`,
      stripePaymentIntentId: paid ? `pi_${orderId.replaceAll('-', '')}` : null,
      paymentExpiresAt: now.add({ minutes: 30 }),
      createdAt: now,
      confirmedAt: paid ? now : null,
      cancelledAt: null,
      version: 1,
      taxStrategyId: null,
      shipToSealed: null,
      sellerOrders: [
        {
          id: sellerOrderId,
          sellerId,
          subtotal,
          shipping: options.fee?.amount ?? 0n,
          discount: 0n,
          shippingDiscount: 0n,
          shippingTaxRateBps: feeTax === null ? null : 1000,
          shippingTax: feeTax?.tax ?? null,
          shippingTaxInclusive: feeTax?.inclusive ?? null,
          total,
          fulfilment: 'to-ship',
          carrier: null,
          trackingRef: null,
          shippedAt: null,
          deliveredAt: null,
          inventoryRecordedAt: null,
          cancelledAt: null,
          ledgerState: 'not-applicable',
          deliveryMethod: options.method ?? 'instant',
          deliveryWindow: null,
          readyAt: null,
          readyPrepMinutes: null,
          deliveryAttention: null,
          buyerFirst: null,
          deliveryQuote:
            options.fleet === undefined
              ? null
              : {
                  quoteId: ids.next<'DeliveryQuote'>(),
                  fleet: options.fleet,
                  quoteAmount: 0n,
                  marginAmount: 0n,
                  quotedAt: now,
                  expiresAt: now.add({ minutes: 10 }),
                },
        },
      ],
      lines: [
        {
          id: ids.next<'OrderLine'>(),
          sellerOrderId,
          offerId: ids.next<'Offer'>(),
          variantId: ids.next<'Variant'>(),
          quantity: 1,
          unitPrice: money(subtotal, currency),
          lineAmount: subtotal,
          discountAmount: 0n,
          discountSellerShare: 0n,
          discountPlatformShare: 0n,
          taxInclusive: true,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
          commissionRateReason: 'standard',
          exclusiveSeller: false,
          taxRateBps: null,
          taxAmount: null,
          taxCategoryCode: null,
        },
      ],
    };
    const stored = await db.unitOfWork.run(market, async () => {
      await orders.insert(market, order);
      const tx = db.service.tx(market);
      const at = (minutes: number) => new Date(now.add({ minutes }).epochMilliseconds);
      const shipped = stage === 'shipped' || stage === 'delivered';
      await tx.orderingSellerOrder.updateMany({
        where: { marketId: market.marketId, id: sellerOrderId },
        data: {
          ...(stage === 'to-prepare' ? {} : { readyAt: at(5) }),
          ...(shipped
            ? {
                fulfilment: stage === 'delivered' ? 'delivered' : 'shipped',
                shippedAt: at(10),
                carrier: 'Courier',
                trackingRef: options.tracking ?? null,
              }
            : {}),
          ...(stage === 'delivered' ? { deliveredAt: at(20) } : {}),
          ...(options.attention === undefined ? {} : { deliveryAttention: options.attention }),
        },
      });
      return ok(undefined);
    });
    if (!stored.ok) throw new Error('could not store the order');
    if (options.sameInstant !== true) clock.advance(Temporal.Duration.from({ minutes: 1 }));
    return { orderId, sellerOrderId };
  };

  const idsOf = async (filter: Partial<ShipmentListFilter>, sort: ShipmentSort = NEWEST) => {
    const rows = await db.unitOfWork.run(
      market,
      async () => ok(await reader.page(market, { ...NO_FILTER, ...filter }, sort, 0, 50)),
      { readOnly: true },
    );
    if (!rows.ok) throw new Error('read failed');
    return rows.value.map((row) => row.sellerOrderId);
  };

  it('lists the seller orders of paid orders only, newest payment first, by stage', async () => {
    const sellerId = ids.next<'Seller'>();
    const prepare = await shipment(sellerId, 'to-prepare');
    const ready = await shipment(sellerId, 'ready');
    const shipped = await shipment(sellerId, 'shipped', { tracking: 'TRK-1' });
    const delivered = await shipment(sellerId, 'delivered');
    await shipment(sellerId, 'to-prepare', { paid: false });

    expect(await idsOf({ sellerId })).toEqual([
      delivered.sellerOrderId,
      shipped.sellerOrderId,
      ready.sellerOrderId,
      prepare.sellerOrderId,
    ]);
    expect(await idsOf({ sellerId, stage: 'to-prepare' })).toEqual([prepare.sellerOrderId]);
    expect(await idsOf({ sellerId, stage: 'ready' })).toEqual([ready.sellerOrderId]);
    expect(await idsOf({ sellerId, stage: 'shipped' })).toEqual([shipped.sellerOrderId]);
    expect(await idsOf({ sellerId, stage: 'delivered' })).toEqual([delivered.sellerOrderId]);

    const counts = await db.unitOfWork.run(
      market,
      async () => ok(await reader.countByStage(market)),
      {
        readOnly: true,
      },
    );
    if (!counts.ok) throw new Error('count failed');
    expect(counts.value.toPrepare).toBeGreaterThanOrEqual(1);
    expect(counts.value.ready).toBeGreaterThanOrEqual(1);
    expect(counts.value.shipped).toBeGreaterThanOrEqual(1);
    expect(counts.value.delivered).toBeGreaterThanOrEqual(1);
  });

  it('lists an order once it is paid: the confirming save writes the payment time', async () => {
    const sellerId = ids.next<'Seller'>();
    const unpaid = await shipment(sellerId, 'to-prepare', { paid: false });
    expect(await idsOf({ sellerId })).toEqual([]);
    const paidAt = clock.now();
    const saved = await db.unitOfWork.run(market, async () => {
      const order = await orders.findById(market, unpaid.orderId);
      if (order === null) throw new Error('order missing');
      return ok(
        await orders.save(market, {
          ...order,
          status: 'confirmed',
          paymentState: 'captured',
          confirmedAt: paidAt,
        }),
      );
    });
    expect(saved.ok && saved.value).toBe('saved');
    const rows = await db.unitOfWork.run(
      market,
      async () => ok(await reader.page(market, { ...NO_FILTER, sellerId }, NEWEST, 0, 10)),
      { readOnly: true },
    );
    expect(rows.ok && rows.value.map((r) => [r.sellerOrderId, r.paidAt.toString()])).toEqual([
      [unpaid.sellerOrderId, paidAt.toString()],
    ]);
  });

  it('shows the delivery fee as the buyer paid it, tax included', async () => {
    const sellerId = ids.next<'Seller'>();
    const outside = await shipment(sellerId, 'ready', {
      fee: { amount: 500n, tax: 50n, inclusive: false },
    });
    const inside = await shipment(sellerId, 'ready', {
      fee: { amount: 550n, tax: 50n, inclusive: true },
    });
    // A fee placed before its tax was recorded counts as having none.
    const untaxed = await shipment(sellerId, 'ready', { fee: { amount: 400n, tax: null } });
    const rows = await db.unitOfWork.run(
      market,
      async () => ok(await reader.page(market, { ...NO_FILTER, sellerId }, NEWEST, 0, 10)),
      { readOnly: true },
    );
    if (!rows.ok) throw new Error('read failed');
    const fee = new Map(rows.value.map((r) => [r.sellerOrderId, r.shipping]));
    expect(fee.get(outside.sellerOrderId)).toEqual({ amount: 550n, currency });
    expect(fee.get(inside.sellerOrderId)).toEqual({ amount: 550n, currency });
    expect(fee.get(untaxed.sellerOrderId)).toEqual({ amount: 400n, currency });
  });

  it('filters by method, fleet, attention, payment time and ship time', async () => {
    const sellerId = ids.next<'Seller'>();
    const start = clock.now();
    const pickup = await shipment(sellerId, 'to-prepare', { method: 'pickup' });
    const middle = clock.now();
    const carried = await shipment(sellerId, 'shipped', { fleet: 'fake_test' });
    const stuck = await shipment(sellerId, 'to-prepare', { attention: 'no-carrier' });

    expect(await idsOf({ sellerId, deliveryMethod: 'pickup' })).toEqual([pickup.sellerOrderId]);
    expect(await idsOf({ sellerId, fleet: 'fake_test' })).toEqual([carried.sellerOrderId]);
    expect(await idsOf({ sellerId, attention: 'any' })).toEqual([stuck.sellerOrderId]);
    expect(await idsOf({ sellerId, attention: 'carrier-unknown' })).toEqual([]);
    expect(await idsOf({ sellerId, attention: 'no-carrier' })).toEqual([stuck.sellerOrderId]);
    expect(await idsOf({ sellerId, paidFrom: start, paidTo: middle })).toEqual([
      pickup.sellerOrderId,
    ]);
    expect(await idsOf({ sellerId, shippedFrom: middle })).toEqual([carried.sellerOrderId]);
    // The stage and the attention filters narrow each other.
    expect(await idsOf({ sellerId, attention: 'any', stage: 'shipped' })).toEqual([]);
  });

  it('narrows to the selected seller orders of an export, beside the filter', async () => {
    const sellerId = ids.next<'Seller'>();
    const a = await shipment(sellerId, 'to-prepare');
    await shipment(sellerId, 'to-prepare');
    const c = await shipment(sellerId, 'shipped');
    expect(await idsOf({ sellerId, ids: [a.sellerOrderId, c.sellerOrderId] })).toEqual([
      c.sellerOrderId,
      a.sellerOrderId,
    ]);
    expect(await idsOf({ ids: [a.sellerOrderId, c.sellerOrderId], stage: 'shipped' })).toEqual([
      c.sellerOrderId,
    ]);
    expect(await idsOf({ ids: [ids.next<'SellerOrder'>()] })).toEqual([]);
  });

  it('finds a shipment by seller order id, order id or tracking reference', async () => {
    const sellerId = ids.next<'Seller'>();
    const target = await shipment(sellerId, 'shipped', { tracking: `TRK-${sellerId}` });
    const spaced = await shipment(sellerId, 'shipped', { tracking: `JD ${sellerId.slice(0, 8)}` });
    await shipment(sellerId, 'shipped', { tracking: 'OTHER' });
    expect(await idsOf({ reference: target.sellerOrderId })).toEqual([target.sellerOrderId]);
    expect(await idsOf({ reference: target.orderId })).toEqual([target.sellerOrderId]);
    expect(await idsOf({ trackingRef: `TRK-${sellerId}` })).toEqual([target.sellerOrderId]);
    expect(await idsOf({ sellerId, trackingRef: `JD ${sellerId.slice(0, 8)}` })).toEqual([
      spaced.sellerOrderId,
    ]);
  });

  it('matches the search by customer account or by store', async () => {
    const sellerA = ids.next<'Seller'>();
    const sellerB = ids.next<'Seller'>();
    const customer = ids.next<'Account'>();
    const byCustomer = await shipment(sellerA, 'ready', { accountId: customer });
    const byStore = await shipment(sellerB, 'ready');
    await shipment(sellerA, 'ready');
    expect(await idsOf({ parties: { accountIds: [customer], sellerIds: [sellerB] } })).toEqual([
      byStore.sellerOrderId,
      byCustomer.sellerOrderId,
    ]);
    expect(await idsOf({ parties: { accountIds: [], sellerIds: [] } })).toEqual([]);
  });

  it('sorts by total and by ship time, with not-shipped rows last', async () => {
    const sellerId = ids.next<'Seller'>();
    const cheap = await shipment(sellerId, 'shipped', { total: 100n });
    const dear = await shipment(sellerId, 'shipped', { total: 900n });
    const waiting = await shipment(sellerId, 'ready', { total: 500n });
    expect(await idsOf({ sellerId }, { key: 'total', direction: 'asc' })).toEqual([
      cheap.sellerOrderId,
      waiting.sellerOrderId,
      dear.sellerOrderId,
    ]);
    expect(await idsOf({ sellerId }, { key: 'shipped', direction: 'desc' })).toEqual([
      dear.sellerOrderId,
      cheap.sellerOrderId,
      waiting.sellerOrderId,
    ]);
    expect(await idsOf({ sellerId }, { key: 'shipped', direction: 'asc' })).toEqual([
      cheap.sellerOrderId,
      dear.sellerOrderId,
      waiting.sellerOrderId,
    ]);
    expect(await idsOf({ sellerId }, { key: 'paid', direction: 'asc' })).toEqual([
      cheap.sellerOrderId,
      dear.sellerOrderId,
      waiting.sellerOrderId,
    ]);
    const handed = await shipment(sellerId, 'delivered', { total: 300n });
    // Not delivered yet: no time, so last either way.
    for (const direction of ['asc', 'desc'] as const) {
      const order = await idsOf({ sellerId }, { key: 'delivered', direction });
      expect(order[0]).toBe(handed.sellerOrderId);
      expect(order).toHaveLength(4);
    }
  });

  it('answers a page with its total, stages and row actions through the use case', async () => {
    const sellerId = ids.next<'Seller'>();
    await shipment(sellerId, 'to-prepare');
    await shipment(sellerId, 'shipped', { tracking: 'TRK-9' });
    await shipment(sellerId, 'delivered');
    const list = new AdminListShipments(gate, {
      unitOfWork: db.unitOfWork,
      shipments: reader,
      labels: new FakeLabels(),
      carrierProgress: new FakeCarrierProgress(),
    });
    const page = await list.execute(admin, { sellerId, pageSize: 2 });
    if (!page.ok) throw new Error(page.error.code);
    expect(page.value).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page.value.rows.map((r) => [r.stage, r.actions])).toEqual([
      ['delivered', ['view-order']],
      ['shipped', ['view-order', 'copy-tracking-reference']],
    ]);
    expect(page.value.rows[1]).toMatchObject({
      carrier: 'Courier',
      trackingRef: 'TRK-9',
      total: { amount: 1000n, currency },
    });
  });

  it('walks Previous/Next pages newest payment first with a keyset cursor', async () => {
    const sellerId = ids.next<'Seller'>();
    const first = await shipment(sellerId, 'to-prepare');
    const second = await shipment(sellerId, 'ready');
    const third = await shipment(sellerId, 'shipped');
    const list = new AdminListShipments(gate, {
      unitOfWork: db.unitOfWork,
      shipments: reader,
      labels: new FakeLabels(),
      carrierProgress: new FakeCarrierProgress(),
    });
    const one = await list.execute(admin, { sellerId, limit: 2 });
    if (!one.ok) throw new Error(one.error.code);
    expect(one.value.rows.map((r) => r.sellerOrderId)).toEqual([
      third.sellerOrderId,
      second.sellerOrderId,
    ]);
    expect(one.value.total).toBeNull();
    const two = await list.execute(admin, { sellerId, limit: 2, cursor: one.value.nextCursor });
    if (!two.ok) throw new Error(two.error.code);
    expect(two.value.rows.map((r) => r.sellerOrderId)).toEqual([first.sellerOrderId]);
    expect(two.value.nextCursor).toBeNull();
  });

  it('walks orders paid at the same instant by id, skipping and repeating none', async () => {
    const sellerId = ids.next<'Seller'>();
    const older = await shipment(sellerId, 'to-prepare');
    const tied = [];
    for (let i = 0; i < 3; i += 1) {
      tied.push(await shipment(sellerId, 'ready', { sameInstant: i < 2 }));
    }
    const newer = await shipment(sellerId, 'shipped');
    const list = new AdminListShipments(gate, {
      unitOfWork: db.unitOfWork,
      shipments: reader,
      labels: new FakeLabels(),
      carrierProgress: new FakeCarrierProgress(),
    });
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let step = 0; step < 6; step += 1) {
      const page = await list.execute(admin, { sellerId, limit: 1, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(page.error.code);
      seen.push(...page.value.rows.map((r) => r.sellerOrderId));
      cursor = page.value.nextCursor;
      if (cursor === null) break;
    }
    // Ties on paid_at fall back to the id, newest first (uuid order is byte order).
    const tiedDesc = tied
      .map((r) => r.sellerOrderId as string)
      .sort()
      .reverse();
    expect(seen).toEqual([newer.sellerOrderId, ...tiedDesc, older.sellerOrderId]);
  });

  it("never shows another Market's shipments", async () => {
    const sellerId = ids.next<'Seller'>();
    const mine = await shipment(sellerId, 'ready');
    const other = marketOf(TEST_MARKETS.find((m) => m !== code)!);
    const rows = await db.unitOfWork.run(
      other,
      async () =>
        ok(
          await reader.page(other, { ...NO_FILTER, reference: mine.sellerOrderId }, NEWEST, 0, 10),
        ),
      { readOnly: true },
    );
    expect(rows.ok && rows.value).toEqual([]);
    // Nor through an export's selected ids.
    const selected = await db.unitOfWork.run(
      other,
      async () =>
        ok(await reader.page(other, { ...NO_FILTER, ids: [mine.sellerOrderId] }, NEWEST, 0, 10)),
      { readOnly: true },
    );
    expect(selected.ok && selected.value).toEqual([]);
  });
});
