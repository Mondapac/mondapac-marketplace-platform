import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { PrismaPickupCodeRepository } from '../../src/modules/ordering/infrastructure/prisma-pickup-code.repository';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import type { PickupCodeRecord } from '../../src/modules/ordering/domain/pickup-code';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The pickup code store on PostgreSQL (ordering.pickup_codes), as the application role, for both
// Market fixtures: round trip, the atomic failure count and the lock at five, replacement by a new
// code, Market scoping, and the CHECKs and grants the application would never break.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';

describe.each(TEST_MARKETS)('pickup code store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let orders: PrismaOrderRepository;
  let codes: PrismaPickupCodeRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    orders = new PrismaOrderRepository(db.service);
    codes = new PrismaPickupCodeRepository(db.service);
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
          deliveryMethod: 'pickup',
          deliveryWindow: null,
          readyAt: null,
          deliveryAttention: null,
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

  const record = (sellerOrderId: Id<'SellerOrder'>, hash = 'hash-1'): PickupCodeRecord => ({
    sellerOrderId,
    hash,
    sealed: `v1.sealed-${hash}`,
    failedAttempts: 0,
    lockedAt: null,
    issuedAt: T0,
  });

  const pickupOrder = async (): Promise<Id<'SellerOrder'>> => {
    const order = newOrder();
    await value(market, () => orders.insert(market, order));
    return order.sellerOrders[0]!.id;
  };

  it('round-trips a code and refuses a second first code', async () => {
    const id = await pickupOrder();
    expect(await value(market, () => codes.find(market, id))).toBeNull();
    expect(await value(market, () => codes.insert(market, record(id)))).toBe(true);
    expect(await value(market, () => codes.insert(market, record(id, 'hash-2')))).toBe(false);

    expect(await value(market, () => codes.find(market, id))).toEqual(record(id));
    const many = await value(market, () => codes.findMany(market, [id, ids.next<'SellerOrder'>()]));
    expect([...many.keys()]).toEqual([id]);
  });

  it('counts wrong codes one by one and locks at five, never counting past it', async () => {
    const id = await pickupOrder();
    await value(market, () => codes.insert(market, record(id)));

    const left: number[] = [];
    for (let n = 0; n < 4; n += 1) {
      const status = await value(market, () => codes.registerFailure(market, id, T0));
      left.push(status!.attemptsLeft);
      expect(status!.locked).toBe(false);
    }
    expect(left).toEqual([4, 3, 2, 1]);

    const locked = await value(market, () => codes.registerFailure(market, id, T0));
    expect(locked).toEqual({ attemptsLeft: 0, locked: true });
    const again = await value(market, () =>
      codes.registerFailure(market, id, T0.add({ minutes: 1 })),
    );
    expect(again).toEqual({ attemptsLeft: 0, locked: true });
    expect(await value(market, () => codes.find(market, id))).toMatchObject({
      failedAttempts: 5,
      lockedAt: T0,
    });
  });

  it('keeps the count exact when failures arrive at the same time', async () => {
    const id = await pickupOrder();
    await value(market, () => codes.insert(market, record(id)));

    await Promise.all(
      Array.from({ length: 8 }, () => value(market, () => codes.registerFailure(market, id, T0))),
    );

    expect(await value(market, () => codes.find(market, id))).toMatchObject({ failedAttempts: 5 });
  });

  it('answers null for a failure on an order without a code', async () => {
    const id = await pickupOrder();
    expect(await value(market, () => codes.registerFailure(market, id, T0))).toBeNull();
  });

  it('replaces the code and clears the count and the lock', async () => {
    const id = await pickupOrder();
    await value(market, () => codes.insert(market, record(id)));
    for (let n = 0; n < 5; n += 1) await value(market, () => codes.registerFailure(market, id, T0));

    const fresh = { ...record(id, 'hash-new'), issuedAt: T0.add({ hours: 1 }) };
    expect(await value(market, () => codes.replace(market, fresh))).toBe(true);
    expect(await value(market, () => codes.find(market, id))).toEqual(fresh);
    expect(
      await value(market, () => codes.replace(market, record(ids.next<'SellerOrder'>()))),
    ).toBe(false);
  });

  it("never shows or counts another Market's code", async () => {
    const id = await pickupOrder();
    await value(market, () => codes.insert(market, record(id)));

    expect(await value(other, () => codes.find(other, id))).toBeNull();
    expect((await value(other, () => codes.findMany(other, [id]))).size).toBe(0);
    expect(await value(other, () => codes.registerFailure(other, id, T0))).toBeNull();
    expect(await value(market, () => codes.find(market, id))).toMatchObject({ failedAttempts: 0 });
  });

  it('refuses out-of-range counts, an early lock and empty values, even for the owner', async () => {
    const id = await pickupOrder();
    await value(market, () => codes.insert(market, record(id)));
    const attempt = (set: string) =>
      owner.query(`UPDATE ordering.pickup_codes SET ${set} WHERE seller_order_id = '${id}'`).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    expect(await attempt('failed_attempts = 6')).toBe(CHECK);
    expect(await attempt('failed_attempts = -1')).toBe(CHECK);
    expect(await attempt('locked_at = now()')).toBe(CHECK);
    expect(await attempt("code_hash = ''")).toBe(CHECK);
    expect(await attempt("code_sealed = ''")).toBe(CHECK);
  });

  it('lets the application change the code columns only, and never delete', async () => {
    const id = await pickupOrder();
    await value(market, () => codes.insert(market, record(id)));
    await expect(
      sql.query(
        `UPDATE ordering.pickup_codes SET seller_order_id = $1 WHERE seller_order_id = $2`,
        [ids.next<'SellerOrder'>(), id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql.query(`DELETE FROM ordering.pickup_codes WHERE seller_order_id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('allows a delivered pickup order without a carrier and refuses it for other methods', async () => {
    const id = await pickupOrder();
    const set = (extra: string) =>
      owner
        .query(
          `UPDATE ordering.seller_orders SET fulfilment = 'delivered', shipped_at = now(),
             delivered_at = now(), ready_at = now() ${extra} WHERE id = $1`,
          [id],
        )
        .then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );
    expect(await set('')).toBe('allowed');

    const base = newOrder();
    const shipped = {
      ...base,
      sellerOrders: base.sellerOrders.map((seller) => ({
        ...seller,
        deliveryMethod: 'same_day' as const,
      })),
    };
    await value(market, () => orders.insert(market, shipped));
    const refused = await owner
      .query(
        `UPDATE ordering.seller_orders SET fulfilment = 'delivered', shipped_at = now(),
           delivered_at = now() WHERE id = $1`,
        [shipped.sellerOrders[0]!.id],
      )
      .then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    expect(refused).toBe(CHECK);
  });
});
