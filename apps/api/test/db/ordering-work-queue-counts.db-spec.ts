import { money, ok, Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { PrismaWorkQueueCountReader } from '../../src/modules/ordering/infrastructure/prisma-work-queue-count.reader';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// The ordering counts of the dashboard's work queue (dashboards upgrade, phase 1) on PostgreSQL, as
// the application role, for both Market fixtures: seller orders past their promise per delivery
// method (not ready by the ready-by time; scheduled not delivered by the window end), with the
// overdue count and the earliest promise passed; refunds pending. Other files write orders into the
// same database at the same time, all in 2026: this file's orders are paid in January 2000 and it
// counts at a moment of that month, so no other file's order is past a promise then.

const T0 = Temporal.Instant.from('2000-01-10T00:00:00Z');

describe.each(TEST_MARKETS)('ordering work-queue counts in market %s (database)', (code) => {
  const market = marketOf(code);
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let orders: PrismaOrderRepository;
  let reader: PrismaWorkQueueCountReader;

  beforeAll(() => {
    db = createPersistence();
    orders = new PrismaOrderRepository(db.service);
    reader = new PrismaWorkQueueCountReader(db.service);
  });
  afterAll(() => db.close());

  const date = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds);

  /**
   * One seller order paid at `paidAt` (its order confirmed then), placed with the delivery method,
   * window and preparation minutes `data` names; the rest of `data` is written after, as the
   * fulfilment units would.
   */
  const sellerOrder = async (
    paidAt: Temporal.Instant,
    data: Record<string, unknown>,
    refund?: {
      readonly gross: bigint;
      readonly state: 'pending' | 'succeeded';
      readonly requestedAt: Temporal.Instant;
    },
  ) => {
    const {
      deliveryMethod = 'instant',
      deliveryWindowStart = null,
      deliveryWindowEnd = null,
      readyPrepMinutes = null,
      ...later
    } = data as {
      deliveryMethod?: 'instant' | 'same_day' | 'pickup' | 'scheduled';
      deliveryWindowStart?: Date | null;
      deliveryWindowEnd?: Date | null;
      readyPrepMinutes?: number | null;
    } & Record<string, unknown>;
    const at = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    const sellerId = ids.next<'Seller'>();
    const order: OrderState = {
      id: orderId,
      marketId: market.marketId,
      accountId: ids.next<'Account'>(),
      status: 'confirmed',
      cancelReason: null,
      paymentState: 'captured',
      total: money(1000n, currency),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: `cs_${orderId.replaceAll('-', '')}`,
      stripePaymentIntentId: `pi_${orderId.replaceAll('-', '')}`,
      paymentExpiresAt: paidAt.add({ minutes: 30 }),
      createdAt: paidAt,
      confirmedAt: paidAt,
      cancelledAt: null,
      version: 1,
      taxStrategyId: null,
      shipToSealed: null,
      sellerOrders: [
        {
          id: sellerOrderId,
          sellerId,
          subtotal: 1000n,
          shipping: 0n,
          discount: 0n,
          shippingDiscount: 0n,
          shippingTaxRateBps: null,
          shippingTax: null,
          shippingTaxInclusive: null,
          total: 1000n,
          fulfilment: 'to-ship',
          carrier: null,
          trackingRef: null,
          shippedAt: null,
          deliveredAt: null,
          inventoryRecordedAt: null,
          ledgerState: 'not-applicable',
          deliveryMethod,
          deliveryWindow:
            deliveryWindowStart === null || deliveryWindowEnd === null
              ? null
              : { start: at(deliveryWindowStart), end: at(deliveryWindowEnd) },
          readyAt: null,
          readyPrepMinutes,
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
          quantity: 1,
          unitPrice: money(1000n, currency),
          lineAmount: 1000n,
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
      if (refund !== undefined) {
        // The refunded gross and its refund in one unit (a deferred check compares them).
        const refundId = ids.next<'Refund'>();
        later.refundedAmount = refund.gross;
        await tx.orderingRefund.create({
          data: {
            id: refundId,
            marketId: market.marketId,
            tenantId: market.tenantId,
            orderId,
            sellerOrderId,
            sellerId,
            currency,
            grossAmount: refund.gross,
            taxAmount: 0n,
            shippingGrossAmount: 0n,
            shippingTaxAmount: 0n,
            reason: 'damaged',
            actorPopulation: 'admin',
            actorAccountId: ids.next<'Account'>(),
            state: refund.state,
            stripeIdempotencyKey: `refund-${refundId}`,
            requestedAt: date(refund.requestedAt),
            ...(refund.state === 'succeeded'
              ? {
                  settledAt: date(refund.requestedAt),
                  stripeRefundId: `re_${refundId.replaceAll('-', '')}`,
                }
              : {}),
          },
        });
      }
      if (Object.keys(later).length > 0) {
        await tx.orderingSellerOrder.updateMany({
          where: { marketId: market.marketId, id: sellerOrderId },
          data: later,
        });
      }
      return ok(undefined);
    });
    if (!stored.ok) throw new Error('could not store the order');
    return { orderId, sellerOrderId, sellerId };
  };

  const read = async <T>(work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(market, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('read failed');
    return result.value;
  };

  it('counts the orders past their promise per delivery method, with overdue and the oldest', async () => {
    const paid = T0.subtract({ hours: 6 });
    // Ready-by = paid + 30 min (5h30 ago): late, and overdue by more than an hour.
    await sellerOrder(paid, { readyPrepMinutes: 30 });
    // Pickup, ready-by = paid + 5h45 (15 min ago): late, not overdue.
    await sellerOrder(paid, { deliveryMethod: 'pickup', readyPrepMinutes: 345 });
    // Same day, ready-by in 2 hours: not late.
    await sellerOrder(paid, { deliveryMethod: 'same_day', readyPrepMinutes: 480 });
    // Marked ready in time, refunded in full, or placed without a promise: never late.
    await sellerOrder(paid, { readyPrepMinutes: 30, readyAt: date(paid.add({ minutes: 20 })) });
    await sellerOrder(
      paid,
      { readyPrepMinutes: 30, refundedInFull: true },
      { gross: 1000n, state: 'succeeded', requestedAt: paid.add({ minutes: 10 }) },
    );
    await sellerOrder(paid, { readyPrepMinutes: null });
    // Scheduled, shipped, window ended 3 hours ago: late and overdue.
    await sellerOrder(paid, {
      deliveryMethod: 'scheduled',
      readyPrepMinutes: 30,
      deliveryWindowStart: date(T0.subtract({ hours: 5 })),
      deliveryWindowEnd: date(T0.subtract({ hours: 3 })),
      readyAt: date(T0.subtract({ hours: 5 })),
      fulfilment: 'shipped',
      shippedAt: date(T0.subtract({ hours: 4 })),
      carrier: 'Courier',
    });
    // Scheduled, window ends in an hour: not late; delivered after its window: not late either.
    await sellerOrder(paid, {
      deliveryMethod: 'scheduled',
      readyPrepMinutes: 30,
      deliveryWindowStart: date(T0),
      deliveryWindowEnd: date(T0.add({ hours: 1 })),
    });
    await sellerOrder(paid, {
      deliveryMethod: 'scheduled',
      readyPrepMinutes: 30,
      deliveryWindowStart: date(T0.subtract({ hours: 5 })),
      deliveryWindowEnd: date(T0.subtract({ hours: 4 })),
      readyAt: date(T0.subtract({ hours: 5 })),
      fulfilment: 'delivered',
      shippedAt: date(T0.subtract({ hours: 5 })),
      deliveredAt: date(T0.subtract({ hours: 3 })),
      carrier: 'Courier',
    });

    const counted = await read(() => reader.lateDeliveries(market, T0, T0.subtract({ hours: 1 })));
    expect(counted).toEqual({ count: 3, overdue: 2, oldestAt: paid.add({ minutes: 30 }) });
  });

  it('counts nothing at a moment before any promise passed', async () => {
    const counted = await read(() =>
      reader.lateDeliveries(
        market,
        Temporal.Instant.from('1999-01-01T00:00:00Z'),
        Temporal.Instant.from('1998-12-31T23:00:00Z'),
      ),
    );
    expect(counted).toEqual({ count: 0, overdue: 0, oldestAt: null });
  });

  it('counts the pending refunds, overdue by their request time', async () => {
    const before = await read(() => reader.pendingRefunds(market, T0));
    const refund = (requestedAt: Temporal.Instant, state: 'pending' | 'succeeded') =>
      sellerOrder(
        T0.subtract({ hours: 72 }),
        // Marked ready in time, so the late count of this file never sees it.
        { readyPrepMinutes: 30, readyAt: date(T0.subtract({ hours: 71 })) },
        { gross: 100n, state, requestedAt },
      );
    await refund(T0.subtract({ hours: 48 }), 'pending');
    await refund(T0.subtract({ hours: 1 }), 'pending');
    await refund(T0.subtract({ hours: 48 }), 'succeeded');

    // Only this file's refunds were requested before T0 (others run in 2026), so the overdue count
    // is exact; the total and the oldest hold at least this file's.
    const counted = await read(() => reader.pendingRefunds(market, T0.subtract({ hours: 24 })));
    expect(counted.overdue).toBe(1);
    expect(counted.count).toBeGreaterThanOrEqual(before.count + 2);
    expect(counted.oldestAt).not.toBeNull();
    expect(
      Temporal.Instant.compare(counted.oldestAt!, T0.subtract({ hours: 48 })),
    ).toBeLessThanOrEqual(0);
  });
});
