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
import { testDatabaseUrl } from './test-database';

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

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaOrderRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
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
      sellerOrders: [
        {
          id: sellerOrderId,
          sellerId: ids.next<'Seller'>(),
          subtotal: 2500n,
          shipping: 0n,
          total: 2500n,
          fulfilment: 'to-ship',
          carrier: null,
          trackingRef: null,
          shippedAt: null,
          deliveredAt: null,
          inventoryRecordedAt: null,
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
      repository.listAll(market, { status: 'confirmed' }, { limit: 100, after: null }),
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
      repository.listAll(other, { status: null }, { limit: 100, after: null }),
    );
    expect(all.some((o) => o.id === order.id)).toBe(false);
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
        `INSERT INTO ordering.seller_orders (id, market_id, tenant_id, order_id, seller_id, subtotal_amount, shipping_amount, total_amount, fulfilment)
         VALUES ($1, $2, $3, $4, $5, 100, 0, 1, 'to-ship')`,
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
  });

  it('shows a seller only its own paid seller orders, newest payment first', async () => {
    const paid = await paidOrder();
    const unpaid = newOrder();
    await value(market, () => repository.insert(market, unpaid));
    const seller = paid.sellerOrders[0]!;
    const unpaidSeller = unpaid.sellerOrders[0]!;

    const own = await value(market, () =>
      repository.listForSeller(market, seller.sellerId, { limit: 10, after: null }),
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
});
