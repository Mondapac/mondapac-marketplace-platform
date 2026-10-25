import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { markDelivered, markShipped } from '../../src/modules/ordering/domain/order';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The order store on PostgreSQL (ordering.orders, seller_orders, order_lines), as the application
// role, for both Market fixtures: round trip with the seller split, the optimistic version, the
// keyset page, the Market guard, and the CHECKs and unique indexes the application would never
// violate but the database must still refuse.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const UNIQUE = '23505';
const CHECK = '23514';

describe.each(TEST_MARKETS)('order repository in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let repository: PrismaOrderRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaOrderRepository(db.service);
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

  const newOrder = (accountId = ids.next<'Account'>(), at = T0): OrderState => {
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    return {
      id: orderId,
      marketId: market.marketId,
      accountId,
      status: 'pending-payment',
      cancelReason: null,
      paymentState: 'none',
      total: money(2500n, currency),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: null,
      stripePaymentIntentId: null,
      paymentExpiresAt: at.add({ minutes: 30 }),
      createdAt: at,
      confirmedAt: null,
      cancelledAt: null,
      version: 1,
      taxStrategyId: ids.next<'TaxStrategy'>(),
      shipToSealed: `v1.ship-to-of-${orderId}`,
      sellerOrders: [
        {
          id: sellerOrderId,
          sellerId: ids.next<'Seller'>(),
          subtotal: 2500n,
          shipping: 0n,
          shippingTaxRateBps: null,
          shippingTax: null,
          shippingTaxInclusive: null,
          total: 2500n,
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
          deliveryQuote: null,
        },
      ],
      lines: [
        {
          id: ids.next<'OrderLine'>(),
          sellerOrderId,
          offerId: ids.next<'Offer'>(),
          variantId: ids.next<'Variant'>(),
          quantity: 2,
          unitPrice: money(1250n, currency),
          lineAmount: 2500n,
          taxInclusive: true,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
          taxRateBps: 1000,
          taxAmount: 227n,
          taxCategoryCode: 'taxable',
        },
      ],
    };
  };

  it('round-trips an order with its seller orders and lines', async () => {
    const order = newOrder();
    await value(market, () => repository.insert(market, order));

    const read = await value(market, () => repository.findById(market, order.id));
    const own = await value(market, () => repository.findOwn(market, order.id, order.accountId));
    const foreign = await value(market, () =>
      repository.findOwn(market, order.id, ids.next<'Account'>()),
    );

    expect(read).toEqual(order);
    expect(own).toEqual(order);
    expect(foreign).toBeNull();
  });

  it('keeps the frozen shipping tax with its rate and price basis', async () => {
    const base = newOrder();
    const order = {
      ...base,
      sellerOrders: base.sellerOrders.map((seller) => ({
        ...seller,
        shippingTaxRateBps: 1000,
        shippingTax: 45n,
        shippingTaxInclusive: true,
      })),
    };
    await value(market, () => repository.insert(market, order));

    // A tax-exclusive order is charged on top: its seller total may exceed subtotal plus shipping.
    const exclusive = newOrder();
    const topped = {
      ...exclusive,
      total: money(2500n + 500n + 250n + 50n, currency),
      sellerOrders: exclusive.sellerOrders.map((seller) => ({
        ...seller,
        shipping: 500n,
        shippingTaxRateBps: 1000,
        shippingTax: 50n,
        shippingTaxInclusive: false,
        total: 2500n + 500n + 250n + 50n,
      })),
    };
    await value(market, () => repository.insert(market, topped));
    expect(await value(market, () => repository.findById(market, topped.id))).toEqual(topped);

    expect(await value(market, () => repository.findById(market, order.id))).toEqual(order);
    // The three columns go together and stay in range, even for the table owner; the application
    // role cannot change them at all.
    const attempt = (set: string) =>
      owner
        .query(`UPDATE ordering.seller_orders SET ${set} WHERE id = '${order.sellerOrders[0]!.id}'`)
        .then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );
    expect(await attempt('shipping_tax_inclusive = NULL')).toBe(CHECK);
    expect(await attempt('shipping_tax_rate_bps = 5001')).toBe(CHECK);
    expect(await attempt('shipping_tax_amount = -1')).toBe(CHECK);
    await expect(
      sql.query(`UPDATE ordering.seller_orders SET shipping_tax_amount = 0 WHERE id = $1`, [
        order.sellerOrders[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  describe('the charged delivery quote', () => {
    const withQuote = (base: OrderState): OrderState => ({
      ...base,
      total: money(2500n + 1150n, currency),
      sellerOrders: base.sellerOrders.map((seller) => ({
        ...seller,
        shipping: 1150n,
        shippingTaxRateBps: 1000,
        shippingTax: 105n,
        shippingTaxInclusive: true,
        total: 2500n + 1150n,
        deliveryQuote: {
          quoteId: ids.next<'DeliveryQuote'>(),
          fleet: 'uber_direct',
          quoteAmount: 1000n,
          marginAmount: 150n,
          quotedAt: T0,
          expiresAt: T0.add({ minutes: 10 }),
        },
      })),
    });

    it('round-trips the fleet, the fleet price, the margin and the expiry of a seller order', async () => {
      const order = withQuote(newOrder());
      await value(market, () => repository.insert(market, order));
      const read = await value(market, () => repository.findById(market, order.id));
      expect(read).toEqual(order);
      expect(read?.sellerOrders[0]?.deliveryQuote).toMatchObject({
        fleet: 'uber_direct',
        quoteAmount: 1000n,
        marginAmount: 150n,
      });
    });

    it('holds a pickup and an older order without a quote', async () => {
      const order = newOrder();
      await value(market, () => repository.insert(market, order));
      const read = await value(market, () => repository.findById(market, order.id));
      expect(read?.sellerOrders[0]?.deliveryQuote).toBeNull();
    });

    it('refuses a quote that is not all there, a fleet that is not one, or a price that does not add up', async () => {
      const order = withQuote(newOrder());
      await value(market, () => repository.insert(market, order));
      const id = order.sellerOrders[0]!.id;
      const attempt = (set: string) =>
        owner.query(`UPDATE ordering.seller_orders SET ${set} WHERE id = '${id}'`).then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );
      expect(await attempt('delivery_quote_fleet = NULL')).toBe(CHECK);
      expect(await attempt("delivery_quote_fleet = 'other-courier'")).toBe(CHECK);
      expect(await attempt('delivery_margin_amount = 151')).toBe(CHECK);
      expect(await attempt('delivery_quote_amount = -1, delivery_margin_amount = 1151')).toBe(
        CHECK,
      );
      // The application role cannot change a charged quote at all.
      await expect(
        sql.query(`UPDATE ordering.seller_orders SET delivery_margin_amount = 0 WHERE id = $1`, [
          id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('saves under the version and refuses a stale write', async () => {
    const order = newOrder();
    await value(market, () => repository.insert(market, order));
    const paid = {
      ...order,
      status: 'confirmed' as const,
      paymentState: 'captured' as const,
      stripePaymentIntentId: `pi_test_${order.id}`,
      confirmedAt: T0.add({ minutes: 5 }),
    };

    expect(await value(market, () => repository.save(market, paid))).toBe('saved');
    expect(await value(market, () => repository.save(market, paid))).toBe('stale');
    const read = await value(market, () => repository.findById(market, order.id));
    expect(read).toMatchObject({ status: 'confirmed', paymentState: 'captured', version: 2 });
  });

  it('lists newest first with a keyset cursor, by account and by status', async () => {
    const account = ids.next<'Account'>();
    const rows = [0, 1, 2].map((n) => newOrder(account, T0.add({ minutes: 60 + n })));
    for (const row of rows) await value(market, () => repository.insert(market, row));

    const first = await value(market, () =>
      repository.listOwn(market, account, { limit: 2, after: null }),
    );
    const second = await value(market, () =>
      repository.listOwn(market, account, {
        limit: 2,
        after: { createdAt: first[1]!.createdAt, id: first[1]!.id },
      }),
    );
    const pending = await value(market, () => repository.findPending(market, account));
    const confirmed = await value(market, () =>
      repository.listAll(
        market,
        { status: 'confirmed', reference: null },
        { limit: 100, after: null },
      ),
    );

    expect(first.map((o) => o.id)).toEqual([rows[2]!.id, rows[1]!.id]);
    expect(second.map((o) => o.id)).toEqual([rows[0]!.id]);
    expect(pending).toHaveLength(3);
    expect(confirmed.every((o) => o.status === 'confirmed')).toBe(true);
  });

  it("never shows another Market's order", async () => {
    const order = newOrder();
    await value(market, () => repository.insert(market, order));

    expect(await value(other, () => repository.findById(other, order.id))).toBeNull();
    const all = await value(other, () =>
      repository.listAll(other, { status: null, reference: null }, { limit: 100, after: null }),
    );
    expect(all.some((o) => o.id === order.id)).toBe(false);
    const byReference = await value(other, () =>
      repository.listAll(other, { status: null, reference: order.id }, { limit: 100, after: null }),
    );
    expect(byReference).toEqual([]);
    const before = await value(market, () => repository.countAll(market));
    await value(market, () => repository.insert(market, newOrder()));
    const after = await value(market, () => repository.countAll(market));
    const otherCounts = await value(other, () => repository.countAll(other));
    expect(after.pendingPayment).toBe(before.pendingPayment + 1);
    expect(await value(other, () => repository.countAll(other))).toEqual(otherCounts);
  });

  it('finds an order by its own id or by one of its seller order ids', async () => {
    const order = newOrder();
    const unrelated = newOrder();
    await value(market, () => repository.insert(market, order));
    await value(market, () => repository.insert(market, unrelated));
    const find = (reference: string) =>
      value(market, () =>
        repository.listAll(market, { status: null, reference }, { limit: 100, after: null }),
      );

    expect((await find(order.id)).map((o) => o.id)).toEqual([order.id]);
    expect((await find(order.sellerOrders[0]!.id)).map((o) => o.id)).toEqual([order.id]);
    expect(await find(ids.next<'Order'>())).toEqual([]);
  });

  const rawOrder = async (overrides: Record<string, unknown>): Promise<string | null> => {
    const orderId = ids.next<'Order'>();
    const row: Record<string, unknown> = {
      id: orderId,
      market_id: market.marketId,
      tenant_id: market.tenantId,
      account_id: ids.next(),
      status: 'pending-payment',
      cancel_reason: null,
      payment_state: 'none',
      currency,
      total_amount: 2500,
      reservation_id: ids.next(),
      stripe_idempotency_key: `checkout-${orderId}`,
      payment_expires_at: T0.add({ minutes: 30 }).toString(),
      created_at: T0.toString(),
      version: 1,
      ...overrides,
    };
    const columns = Object.keys(row);
    try {
      await sql.query(
        `INSERT INTO ordering.orders (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  };

  it('refuses what the application never writes', async () => {
    const key = `checkout-${ids.next<'Order'>()}`;
    expect(await rawOrder({ stripe_idempotency_key: key })).toBeNull();
    expect(await rawOrder({ stripe_idempotency_key: key })).toBe(UNIQUE);
    const session = `cs_test_${ids.next<'Order'>()}`;
    expect(await rawOrder({ stripe_session_id: session })).toBeNull();
    expect(await rawOrder({ stripe_session_id: session })).toBe(UNIQUE);
    // A confirmed order needs its time, a cancelled one its reason; a total is positive.
    expect(await rawOrder({ status: 'confirmed', payment_state: 'captured' })).toBe(CHECK);
    expect(await rawOrder({ status: 'cancelled', cancelled_at: T0.toString() })).toBe(CHECK);
    expect(await rawOrder({ status: 'pending-payment', cancel_reason: 'expired' })).toBe(CHECK);
    expect(await rawOrder({ total_amount: 0 })).toBe(CHECK);
    // A confirmed order is captured; a cancelled one never keeps an open authorisation.
    expect(
      await rawOrder({
        status: 'confirmed',
        payment_state: 'authorised',
        confirmed_at: T0.toString(),
      }),
    ).toBe(CHECK);
    expect(
      await rawOrder({
        status: 'cancelled',
        cancel_reason: 'superseded',
        cancelled_at: T0.toString(),
        payment_state: 'authorised',
      }),
    ).toBe(CHECK);
    expect(await rawOrder({ payment_state: 'refunded' })).toBe(CHECK);
    expect(await rawOrder({ currency: 'aud' })).toBe(CHECK);
  });

  it('keeps the seller order and line sums consistent in the database', async () => {
    const order = newOrder();
    await value(market, () => repository.insert(market, order));
    const seller = order.sellerOrders[0]!;
    const line = order.lines[0]!;
    const attempt = (statement: string, params: unknown[]) =>
      sql.query(statement, params).then(
        () => null,
        (error: { code?: string }) => error.code ?? 'unknown',
      );

    expect(
      await attempt(
        `INSERT INTO ordering.seller_orders (id, market_id, tenant_id, order_id, seller_id, subtotal_amount, shipping_amount, total_amount, fulfilment, ledger_state, delivery_method)
         VALUES ($1, $2, $3, $4, $5, 100, 0, 1, 'to-ship', 'pending', 'instant')`,
        [ids.next(), market.marketId, market.tenantId, order.id, ids.next()],
      ),
    ).toBe(CHECK);
    expect(
      await attempt(
        `INSERT INTO ordering.order_lines (id, market_id, tenant_id, order_id, seller_order_id, offer_id, variant_id, quantity, unit_amount, line_amount, tax_inclusive, reservation_line_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 3, 100, 1, true, $8)`,
        [
          ids.next(),
          market.marketId,
          market.tenantId,
          order.id,
          seller.id,
          line.offerId,
          ids.next(),
          ids.next(),
        ],
      ),
    ).toBe(CHECK);
  });

  it('lets the application role change an order but never delete one', async () => {
    const order = newOrder();
    await value(market, () => repository.insert(market, order));
    const attempt = (statement: string) =>
      sql.query(statement).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );

    expect(await attempt(`DELETE FROM ordering.orders WHERE id = '${order.id}'`)).toBe('42501');
    expect(await attempt(`DELETE FROM ordering.order_lines WHERE order_id = '${order.id}'`)).toBe(
      '42501',
    );
    expect(
      await attempt(`UPDATE ordering.orders SET total_amount = 1 WHERE id = '${order.id}'`),
    ).toBe('42501');
  });

  const paidOrder = async (): Promise<OrderState> => {
    const order = newOrder();
    await value(market, () => repository.insert(market, order));
    const paid = {
      ...order,
      status: 'confirmed' as const,
      paymentState: 'captured' as const,
      stripePaymentIntentId: `pi_test_${order.id}`,
      confirmedAt: T0.add({ minutes: 5 }),
    };
    await value(market, () => repository.save(market, paid));
    return paid;
  };

  it('moves a seller order forward once and refuses a stale step', async () => {
    const paid = await paidOrder();
    const seller = paid.sellerOrders[0]!;
    const shipped = markShipped(
      seller,
      { carrier: 'Australia Post', trackingRef: 'AP1' },
      T0.add({ hours: 1 }),
    )!;
    const delivered = markDelivered(shipped, T0.add({ hours: 5 }))!;

    expect(await value(market, () => repository.saveFulfilment(market, shipped, 'to-ship'))).toBe(
      'saved',
    );
    expect(await value(market, () => repository.saveFulfilment(market, shipped, 'to-ship'))).toBe(
      'stale',
    );
    expect(await value(market, () => repository.saveFulfilment(market, delivered, 'shipped'))).toBe(
      'saved',
    );

    const read = await value(market, () =>
      repository.findForSeller(market, seller.sellerId, seller.id),
    );
    expect(read?.sellerOrder).toMatchObject({
      fulfilment: 'delivered',
      carrier: 'Australia Post',
      trackingRef: 'AP1',
    });
    expect(read?.orderId).toBe(paid.id);
    expect(read?.lines).toHaveLength(1);
    // The seller's page opens the order's sealed address under the customer's account.
    expect(read?.accountId).toBe(paid.accountId);
    expect(read?.shipToSealed).toBe(paid.shipToSealed);
  });

  it("answers the customer account of a seller's own paid seller orders only", async () => {
    const paid = await paidOrder();
    const unpaid = newOrder();
    await value(market, () => repository.insert(market, unpaid));
    const seller = paid.sellerOrders[0]!;
    const unpaidSeller = unpaid.sellerOrders[0]!;

    const own = await value(market, () =>
      repository.customerAccountsForSeller(market, seller.sellerId, [seller.id, unpaidSeller.id]),
    );
    const foreign = await value(market, () =>
      repository.customerAccountsForSeller(market, ids.next<'Seller'>(), [seller.id]),
    );
    const elsewhere = await value(other, () =>
      repository.customerAccountsForSeller(other, seller.sellerId, [seller.id]),
    );

    expect([...own]).toEqual([[seller.id, paid.accountId]]);
    expect(foreign.size).toBe(0);
    expect(elsewhere.size).toBe(0);
    expect(
      await value(market, () => repository.customerAccountsForSeller(market, seller.sellerId, [])),
    ).toEqual(new Map());
  });

  it('shows a seller only its own paid seller orders, newest payment first', async () => {
    const paid = await paidOrder();
    const unpaid = newOrder();
    await value(market, () => repository.insert(market, unpaid));
    const seller = paid.sellerOrders[0]!;
    const unpaidSeller = unpaid.sellerOrders[0]!;

    const own = await value(market, () =>
      repository.listForSeller(
        market,
        seller.sellerId,
        { fulfilment: null },
        { limit: 10, after: null },
      ),
    );
    const toShip = await value(market, () =>
      repository.listForSeller(
        market,
        seller.sellerId,
        { fulfilment: 'to-ship' },
        { limit: 10, after: null },
      ),
    );
    const shipped = await value(market, () =>
      repository.listForSeller(
        market,
        seller.sellerId,
        { fulfilment: 'shipped' },
        { limit: 10, after: null },
      ),
    );
    const foreign = await value(market, () =>
      repository.findForSeller(market, ids.next<'Seller'>(), seller.id),
    );
    const notPaid = await value(market, () =>
      repository.findForSeller(market, unpaidSeller.sellerId, unpaidSeller.id),
    );
    const elsewhere = await value(other, () =>
      repository.findForSeller(other, seller.sellerId, seller.id),
    );

    expect(own.map((r) => r.sellerOrder.id)).toEqual([seller.id]);
    expect(toShip.map((r) => r.sellerOrder.id)).toEqual([seller.id]);
    expect(shipped).toEqual([]);
    expect(await value(market, () => repository.countForSeller(market, seller.sellerId))).toEqual({
      toShip: 1,
      shipped: 0,
      delivered: 0,
    });
    expect(
      await value(market, () => repository.countForSeller(market, unpaidSeller.sellerId)),
    ).toEqual({ toShip: 0, shipped: 0, delivered: 0 });
    expect(foreign).toBeNull();
    expect(notPaid).toBeNull();
    expect(elsewhere).toBeNull();
  });

  it('queues shipped orders for inventory once and marks them recorded', async () => {
    const paid = await paidOrder();
    const seller = paid.sellerOrders[0]!;
    const shipped = markShipped(
      seller,
      { carrier: 'Post', trackingRef: null },
      T0.add({ hours: 1 }),
    )!;
    await value(market, () => repository.saveFulfilment(market, shipped, 'to-ship'));

    const queued = await value(market, () => repository.findUnrecordedShipments(market, 500));
    expect(queued.some((r) => r.sellerOrder.id === seller.id)).toBe(true);

    await value(market, () =>
      repository.markInventoryRecorded(market, seller.id, T0.add({ hours: 2 })),
    );
    await value(market, () =>
      repository.markInventoryRecorded(market, seller.id, T0.add({ hours: 3 })),
    );
    const after = await value(market, () => repository.findUnrecordedShipments(market, 500));
    const read = await value(market, () =>
      repository.findForSeller(market, seller.sellerId, seller.id),
    );

    expect(after.some((r) => r.sellerOrder.id === seller.id)).toBe(false);
    expect(read?.sellerOrder.inventoryRecordedAt?.toString()).toBe(T0.add({ hours: 2 }).toString());
  });

  it('queues paid seller orders for the ledger once and marks them recorded', async () => {
    const paid = await paidOrder();
    const seller = paid.sellerOrders[0]!;

    const queued = await value(market, () => repository.findUnrecordedLedger(market, 500));
    const entry = queued.find((r) => r.sellerOrder.id === seller.id);
    expect(entry?.lines.map((l) => l.commissionRateBps)).toEqual([1500]);

    await value(market, () => repository.markLedgerRecorded(market, seller.id));
    await value(market, () => repository.markLedgerRecorded(market, seller.id));
    const after = await value(market, () => repository.findUnrecordedLedger(market, 500));
    const read = await value(market, () =>
      repository.findForSeller(market, seller.sellerId, seller.id),
    );
    expect(after.some((r) => r.sellerOrder.id === seller.id)).toBe(false);
    expect(read?.sellerOrder.ledgerState).toBe('recorded');
    const refused = (set: string) =>
      sql.query(`UPDATE ordering.seller_orders SET ${set} WHERE id = '${seller.id}'`).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    expect(await refused(`ledger_state = 'done'`)).toBe('23514');
  });

  it('refuses fulfilment fields that do not fit the state', async () => {
    const paid = await paidOrder();
    const id = paid.sellerOrders[0]!.id;
    const attempt = (set: string) =>
      sql.query(`UPDATE ordering.seller_orders SET ${set} WHERE id = '${id}'`).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );

    // Shipped needs a carrier and a time; delivery cannot precede shipment; a to-ship order has none.
    expect(await attempt(`fulfilment = 'shipped'`)).toBe(CHECK);
    expect(await attempt(`fulfilment = 'shipped', carrier = 'Post'`)).toBe(CHECK);
    expect(
      await attempt(
        `fulfilment = 'delivered', carrier = 'Post', shipped_at = now(), delivered_at = now() - interval '1 day'`,
      ),
    ).toBe(CHECK);
    expect(await attempt(`carrier = 'Post'`)).toBe(CHECK);
    expect(await attempt(`fulfilment = 'lost'`)).toBe(CHECK);
    expect(await attempt(`subtotal_amount = 1`)).toBe('42501');
  });

  describe('delivery method, ready time and attention', () => {
    const withMethod = (
      base: OrderState,
      deliveryMethod: 'pickup' | 'instant' | 'same_day' | 'scheduled',
      deliveryWindow: { start: Temporal.Instant; end: Temporal.Instant } | null,
    ): OrderState => ({
      ...base,
      sellerOrders: base.sellerOrders.map((s) => ({ ...s, deliveryMethod, deliveryWindow })),
    });

    it.each(['pickup', 'instant', 'same_day'] as const)(
      'round-trips the %s method with no window',
      async (method) => {
        const order = withMethod(newOrder(), method, null);
        await value(market, () => repository.insert(market, order));
        expect(await value(market, () => repository.findById(market, order.id))).toEqual(order);
      },
    );

    it('round-trips a scheduled method with its window as UTC instants', async () => {
      const window = { start: T0.add({ hours: 26 }), end: T0.add({ hours: 28 }) };
      const order = withMethod(newOrder(), 'scheduled', window);
      await value(market, () => repository.insert(market, order));
      const read = await value(market, () => repository.findById(market, order.id));
      expect(read?.sellerOrders[0]?.deliveryWindow).toEqual(window);
    });

    it('refuses a method without its window, a window on another method and an empty window', async () => {
      const insert = (order: OrderState) =>
        value(market, () => repository.insert(market, order)).then(
          () => 'allowed',
          (error: { code?: string; meta?: { code?: string } }) =>
            error.meta?.code ?? error.code ?? 'error',
        );
      const window = { start: T0.add({ hours: 2 }), end: T0.add({ hours: 3 }) };
      expect(await insert(withMethod(newOrder(), 'scheduled', null))).not.toBe('allowed');
      expect(await insert(withMethod(newOrder(), 'instant', window))).not.toBe('allowed');
      expect(
        await insert(withMethod(newOrder(), 'scheduled', { start: window.end, end: window.start })),
      ).not.toBe('allowed');
    });

    it('saves ready once, only while to-ship, and then answers stale', async () => {
      const order = newOrder();
      await value(market, () => repository.insert(market, order));
      const seller = order.sellerOrders[0]!;
      const ready = { ...seller, readyAt: T0.add({ minutes: 5 }) };

      expect(await value(market, () => repository.saveReady(market, ready))).toBe('saved');
      expect(await value(market, () => repository.saveReady(market, ready))).toBe('stale');
      const read = await value(market, () => repository.findById(market, order.id));
      expect(read?.sellerOrders[0]?.readyAt).toEqual(ready.readyAt);
      // Another Market's id of the same value finds nothing.
      expect(await value(other, () => repository.saveReady(other, ready))).toBe('stale');
    });

    it('saves the platform-attention state once', async () => {
      const order = newOrder();
      await value(market, () => repository.insert(market, order));
      const flagged = { ...order.sellerOrders[0]!, deliveryAttention: 'no-carrier' as const };

      expect(await value(market, () => repository.saveAttention(market, flagged))).toBe('saved');
      expect(await value(market, () => repository.saveAttention(market, flagged))).toBe('stale');
      const read = await value(market, () => repository.findById(market, order.id));
      expect(read?.sellerOrders[0]?.deliveryAttention).toBe('no-carrier');
    });
  });
});
