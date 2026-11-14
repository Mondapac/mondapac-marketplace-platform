import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { OrderState, SellerOrder } from './order';
import { orderActivity, sellerOrderActivity } from './order-activity';
import type { Refund } from './refund';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const T0 = Temporal.Instant.from('2026-11-10T01:00:00Z');
const at = (minutes: number) => T0.add({ minutes });
const ORDER = id<'Order'>(0x1);
const SO_A = id<'SellerOrder'>(0xa1);
const SO_B = id<'SellerOrder'>(0xb1);
const SELLER_A = id<'Seller'>(0xa);
const SELLER_B = id<'Seller'>(0xb);

// Two Market fixtures: AU (AUD, tax inside) and a synthetic market (JPY, tax on top).
describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('order activity in market %s', (marketId, currency) => {
  const sellerOrder = (
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
    patch: Partial<SellerOrder> = {},
  ): SellerOrder => ({
    id: sellerOrderId,
    sellerId,
    subtotal: 3000n,
    shipping: 500n,
    shippingTaxRateBps: null,
    shippingTax: null,
    shippingTaxInclusive: null,
    total: 3500n,
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
    readyPrepMinutes: null,
    deliveryAttention: null,
    deliveryQuote: null,
    ...patch,
  });
  const order = (patch: Partial<OrderState> = {}): OrderState => ({
    id: ORDER,
    marketId: marketId as OrderState['marketId'],
    accountId: id<'Account'>(0xc),
    status: 'confirmed',
    cancelReason: null,
    paymentState: 'captured',
    total: money(7000n, currency),
    reservationId: 'r',
    stripeIdempotencyKey: 'k',
    stripeSessionId: null,
    stripePaymentIntentId: null,
    paymentExpiresAt: at(30),
    createdAt: T0,
    confirmedAt: at(2),
    cancelledAt: null,
    version: 2,
    taxStrategyId: null,
    shipToSealed: null,
    sellerOrders: [sellerOrder(SO_A, SELLER_A), sellerOrder(SO_B, SELLER_B)],
    lines: [],
    ...patch,
  });
  const refund = (
    n: number,
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
    patch: Partial<Refund> = {},
  ): Refund => ({
    id: id<'Refund'>(n),
    orderId: ORDER,
    sellerOrderId,
    sellerId,
    currency,
    gross: 1100n,
    tax: 100n,
    shipping: null,
    reason: 'damaged',
    lossBearer: 'seller',
    lossReasonCode: null,
    actor: { population: 'admin', accountId: id<'Account'>(0xad) },
    state: 'pending',
    stripeIdempotencyKey: `refund-${n}`,
    stripeRefundId: null,
    attempts: 0,
    requestedAt: at(60),
    settledAt: null,
    lines: [],
    ...patch,
  });

  it('lists the whole order for the admin, oldest first, with every seller order and refund', () => {
    const full = order({
      sellerOrders: [
        sellerOrder(SO_A, SELLER_A, {
          readyAt: at(10),
          shippedAt: at(20),
          deliveredAt: at(40),
          fulfilment: 'delivered',
        }),
        sellerOrder(SO_B, SELLER_B, {
          deliveryMethod: 'pickup',
          readyAt: at(10),
          deliveredAt: at(50),
          fulfilment: 'delivered',
        }),
      ],
    });
    const refunds = [
      refund(0x2, SO_B, SELLER_B, {
        reason: 'item-unavailable',
        actor: { population: 'seller', accountId: id<'Account'>(0x5e) },
        state: 'succeeded',
        settledAt: at(61),
      }),
      refund(0x1, SO_A, SELLER_A, { state: 'failed', settledAt: at(62), requestedAt: at(55) }),
      // Another order's refund never shows here.
      refund(0x3, SO_A, SELLER_A, { orderId: id<'Order'>(0x99) }),
    ];

    const events = orderActivity(full, refunds);

    expect(events.map((e) => [e.kind, e.at.toString(), e.sellerOrderId, e.by])).toEqual([
      ['order-placed', T0.toString(), null, 'customer'],
      ['order-paid', at(2).toString(), null, null],
      ['seller-order-ready', at(10).toString(), SO_A, 'seller'],
      ['seller-order-ready', at(10).toString(), SO_B, 'seller'],
      ['seller-order-shipped', at(20).toString(), SO_A, null],
      ['seller-order-delivered', at(40).toString(), SO_A, null],
      ['seller-order-collected', at(50).toString(), SO_B, 'seller'],
      ['refund-requested', at(55).toString(), SO_A, 'admin'],
      ['refund-requested', at(60).toString(), SO_B, 'seller'],
      ['refund-succeeded', at(61).toString(), SO_B, null],
      ['refund-failed', at(62).toString(), SO_A, null],
    ]);
    const requested = events.find((e) => e.kind === 'refund-requested' && e.sellerOrderId === SO_B);
    expect(requested).toMatchObject({
      refundId: id<'Refund'>(0x2),
      amount: money(1100n, currency),
      reason: 'item-unavailable',
    });
  });

  it('shows an order cancelled before payment with its reason, and no paid step', () => {
    const events = orderActivity(
      order({
        status: 'cancelled',
        paymentState: 'none',
        confirmedAt: null,
        cancelReason: 'expired',
        cancelledAt: at(30),
      }),
      [],
    );
    expect(events.map((e) => [e.kind, e.reason])).toEqual([
      ['order-placed', null],
      ['order-cancelled', 'expired'],
    ]);
  });

  it('leaves out a pending refund outcome and keeps all UTC instants', () => {
    const events = orderActivity(order(), [refund(0x1, SO_A, SELLER_A)]);
    expect(events.map((e) => e.kind)).toEqual(['order-placed', 'order-paid', 'refund-requested']);
    for (const e of events) expect(e.at.toString()).toMatch(/Z$/);
  });

  it("shows the seller only its own seller order from payment on, never another shop's refund", () => {
    const record = {
      sellerOrder: sellerOrder(SO_A, SELLER_A, { readyAt: at(10), shippedAt: at(20) }),
      confirmedAt: at(2),
    };
    const refunds = [
      refund(0x1, SO_A, SELLER_A, { state: 'succeeded', settledAt: at(70) }),
      refund(0x2, SO_B, SELLER_B),
      // A refund naming this seller order under another seller is not this shop's.
      refund(0x3, SO_A, SELLER_B),
    ];

    const events = sellerOrderActivity(record, refunds);

    expect(events.map((e) => [e.kind, e.sellerOrderId])).toEqual([
      ['order-paid', SO_A],
      ['seller-order-ready', SO_A],
      ['seller-order-shipped', SO_A],
      ['refund-requested', SO_A],
      ['refund-succeeded', SO_A],
    ]);
    expect(events.some((e) => e.kind === 'order-placed')).toBe(false);
    expect(
      JSON.stringify(events, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
    ).not.toContain(SO_B);
  });

  it('orders events of the same instant by step, then by id, every time', () => {
    const same = order({
      confirmedAt: T0,
      sellerOrders: [
        sellerOrder(SO_B, SELLER_B, { readyAt: T0 }),
        sellerOrder(SO_A, SELLER_A, { readyAt: T0 }),
      ],
    });
    const once = orderActivity(same, []).map((e) => [e.kind, e.sellerOrderId]);
    expect(once).toEqual([
      ['order-placed', null],
      ['order-paid', null],
      ['seller-order-ready', SO_A],
      ['seller-order-ready', SO_B],
    ]);
    expect(orderActivity(same, []).map((e) => [e.kind, e.sellerOrderId])).toEqual(once);
  });
});
