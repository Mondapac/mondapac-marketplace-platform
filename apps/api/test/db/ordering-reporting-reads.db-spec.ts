import { FakeOrderProducts, FakePromotions } from '../support/ordering-promotions-fakes';
import { testAreas } from '../support/ordering-policy';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import type { OrderingDependencies } from '../../src/modules/ordering/application/checkout-flow';
import { AdminRefundOrder } from '../../src/modules/ordering/application/use-cases/admin-refund-order.use-case';
import { ConfirmPayment } from '../../src/modules/ordering/application/use-cases/confirm-payment.use-case';
import { ORDERING_AUDIT_ACTIONS } from '../../src/modules/ordering/domain/audit';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { ConfigOrderingPolicy } from '../../src/modules/ordering/infrastructure/config-ordering-policy';
import { RefundReportFactsQuery } from '../../src/modules/ordering/application/use-cases/refund-report-facts.use-case';
import { RefundsSucceededQuery } from '../../src/modules/ordering/application/use-cases/refunds-succeeded.use-case';
import { SellerOrdersChangedQuery } from '../../src/modules/ordering/application/use-cases/seller-orders-changed.use-case';
import { SellerOrderReportFactsQuery } from '../../src/modules/ordering/application/use-cases/seller-order-report-facts.use-case';
import { PrismaReportingChangesReader } from '../../src/modules/ordering/infrastructure/prisma-reporting-changes.reader';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { PrismaPickupCodeRepository } from '../../src/modules/ordering/infrastructure/prisma-pickup-code.repository';
import { PrismaRefundRepository } from '../../src/modules/ordering/infrastructure/prisma-refund.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import {
  AllowAllDeliveryMethods,
  FakeAttemptLimits,
  FakeCart,
  FakeCommission,
  FakeCustomers,
  FakeGateway,
  FakeInventory,
  FakeLabels,
  FakePickupVault,
  FakeShipping,
  FakeShipToCipher,
  FakeTax,
  FakeTaxCategories,
} from '../support/ordering-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// What reporting reads of ordering on PostgreSQL (dashboards upgrade phase 3), for both Market
// fixtures: a paid seller order's facts (goods after discount with tax, shipping, paid time), a
// succeeded refund's facts with the Offer of each line, a pending or failed refund absent, the
// changes of a window paged by id, and another Market's rows never seen.

const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class RefundsOn extends ConfigOrderingPolicy {
  override refundsEnabled(): boolean {
    return true;
  }
}

describe.each(TEST_MARKETS)('ordering reporting reads in market %s (database)', (code) => {
  const market = marketOf(code);
  const inclusive = code === 'AU';
  const currency = inclusive ? 'AUD' : 'JPY';
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let gateway: FakeGateway;
  let deps: OrderingDependencies;
  let admin: CallContext;
  let system: CallContext;
  let audit: AuditWriter;

  beforeAll(() => {
    db = createPersistence();
    admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    system = testCallContext(market, 'system');
    const catalogue = new AuditActionCatalogue();
    catalogue.register('ordering', ORDERING_AUDIT_ACTIONS);
    catalogue.seal();
    audit = PersistenceModule.auditWriterFor('ordering').useFactory(
      catalogue,
      ids,
      clock,
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
  });
  afterAll(() => db.close());
  beforeEach(() => {
    gateway = new FakeGateway();
    deps = {
      unitOfWork: db.unitOfWork,
      orders: new PrismaOrderRepository(db.service),
      refunds: new PrismaRefundRepository(db.service),
      gateway,
      policy: new RefundsOn(markets, testAreas),
      cart: new FakeCart(),
      customers: new FakeCustomers(),
      shipTo: new FakeShipToCipher(),
      inventory: new FakeInventory(),
      shipping: new FakeShipping(),
      commission: new FakeCommission(),
      tax: new FakeTax(),
      taxCategories: new FakeTaxCategories('taxable'),
      products: new FakeOrderProducts(),
      promotions: new FakePromotions(),
      outbox: { append: () => Promise.resolve() },
      audit,
      ids,
      clock,
      labels: new FakeLabels(),
      deliveryMethods: new AllowAllDeliveryMethods(),
      pickupCodes: new PrismaPickupCodeRepository(db.service),
      pickupVault: new FakePickupVault(),
      attempts: new FakeAttemptLimits(),
    };
  });

  const lineTax = inclusive ? 300n : 451n;
  const shipping = inclusive ? 550n : 500n;
  const shippingTax = inclusive ? 50n : 75n;
  const total = inclusive ? 3300n + 550n : 3300n + 451n + 500n + 75n;

  /** A paid order of one seller with one line of three units of 11.00 (or 1100). */
  const paidOrder = async (sellerId: Id<'Seller'>, accountId = ids.next<'Account'>()) => {
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    const lineId = ids.next<'OrderLine'>();
    const order: OrderState = {
      id: orderId,
      marketId: market.marketId,
      accountId,
      status: 'pending-payment',
      cancelReason: null,
      paymentState: 'none',
      total: money(total, currency),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: `cs_${orderId.replaceAll('-', '')}`,
      stripePaymentIntentId: null,
      paymentExpiresAt: T0.add({ minutes: 30 }),
      createdAt: T0,
      confirmedAt: null,
      cancelledAt: null,
      version: 1,
      taxStrategyId: null,
      shipToSealed: null,
      sellerOrders: [
        {
          id: sellerOrderId,
          sellerId,
          subtotal: 3300n,
          shipping,
          discount: 0n,
          shippingDiscount: 0n,
          shippingTaxRateBps: inclusive ? 1000 : 1500,
          shippingTax,
          shippingTaxInclusive: inclusive,
          total,
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
        },
      ],
      lines: [
        {
          id: lineId,
          sellerOrderId,
          offerId: ids.next<'Offer'>(),
          variantId: ids.next<'Variant'>(),
          quantity: 3,
          unitPrice: money(1100n, currency),
          lineAmount: 3300n,
          discountAmount: 0n,
          discountSellerShare: 0n,
          discountPlatformShare: 0n,
          taxInclusive: inclusive,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
          commissionRateReason: 'standard',
          exclusiveSeller: false,
          taxRateBps: inclusive ? 1000 : 1500,
          taxAmount: lineTax,
          taxCategoryCode: inclusive ? 'taxable' : 'zz_standard',
        },
      ],
    };
    const stored = await db.unitOfWork.run(market, async () => {
      await deps.orders.insert(market, order);
      return ok(undefined);
    });
    if (!stored.ok) throw new Error('could not store the order');
    const confirmed = await new ConfirmPayment(gate, deps).execute(system, {
      orderId,
      paymentIntentId: `pi_${orderId.replaceAll('-', '')}`,
      sessionId: `cs_${orderId.replaceAll('-', '')}`,
      amount: order.total,
    });
    if (!confirmed.ok) throw new Error(`could not confirm: ${confirmed.error.code}`);
    return { orderId, sellerOrderId, lineId, accountId };
  };

  /**
   * A refund of `units` units, ending as Stripe answers; the clock moves a minute after it unless
   * `sameInstant` keeps it (to request several refunds at one time).
   */
  const refunded = async (
    sellerId: Id<'Seller'>,
    units: number,
    answer: 'succeeded' | 'pending' | 'failed',
    options: {
      accountId?: Id<'Account'>;
      reason?: string;
      platform?: boolean;
      sameInstant?: boolean;
    } = {},
  ) => {
    const o = await paidOrder(sellerId, options.accountId);
    gateway.refundAnswers = answer;
    const result = await new AdminRefundOrder(gate, deps).execute(admin, {
      orderId: o.orderId,
      sellerOrderId: o.sellerOrderId,
      lines: [{ orderLineId: o.lineId, quantity: units }],
      shippingAmount: undefined,
      reason: options.reason ?? 'damaged',
      ...(options.platform === true ? { lossBearer: 'platform', lossReasonCode: 'goodwill' } : {}),
    });
    if (options.sameInstant !== true) clock.advance(Temporal.Duration.from({ minutes: 1 }));
    if (result.ok) return { ...o, refundId: result.value.refundId };
    throw new Error(`could not refund: ${result.error.code}`);
  };

  const changesDeps = () => ({
    unitOfWork: db.unitOfWork,
    changes: new PrismaReportingChangesReader(db.service),
  });
  const other = marketOf(code === 'AU' ? 'ZZ' : 'AU');
  const otherSystem = () => testCallContext(other, 'system');

  it('answers a paid seller order with its goods, shipping and paid time, ids and money only', async () => {
    const sellerId = ids.next<'Seller'>();
    const o = await paidOrder(sellerId);
    const facts = await new SellerOrderReportFactsQuery(gate, deps).execute(system, {
      sellerOrders: [{ orderId: o.orderId, sellerOrderId: o.sellerOrderId }],
    });
    if (!facts.ok) throw new Error(facts.error.code);
    expect(facts.value).toHaveLength(1);
    const fact = facts.value[0]!;
    expect(fact).toMatchObject({
      orderId: o.orderId,
      sellerOrderId: o.sellerOrderId,
      sellerId,
      currency,
      cancelledAt: null,
      shippedAt: null,
      shippedOnTime: null,
      deliveredAt: null,
      // The method and shipping's quote id only (dashboards v2): never the ship-to address.
      deliveryMethod: 'instant',
      deliveryQuoteId: null,
    });
    expect(fact.paidAt).not.toBeNull();
    expect(fact.lines.map((line) => [line.quantity, line.goods])).toEqual([
      [3, inclusive ? { amount: 3300n, tax: 300n } : { amount: 3751n, tax: 451n }],
    ]);
    expect(typeof fact.lines[0]?.offerId).toBe('string');
    expect(fact.shipping).toEqual(
      inclusive ? { amount: 550n, tax: 50n } : { amount: 575n, tax: 75n },
    );
    expect(Object.keys(fact).sort()).toEqual(
      [
        'cancelledAt',
        'currency',
        'deliveredAt',
        'deliveryMethod',
        'deliveryQuoteId',
        'lines',
        'orderId',
        'paidAt',
        'sellerId',
        'sellerOrderId',
        'shippedAt',
        'shippedOnTime',
        'shipping',
      ].sort(),
    );

    // A null seller order asks for every seller order of the order.
    const whole = await new SellerOrderReportFactsQuery(gate, deps).execute(system, {
      sellerOrders: [{ orderId: o.orderId, sellerOrderId: null }],
    });
    expect(whole.ok && whole.value.map((f) => f.sellerOrderId)).toEqual([o.sellerOrderId]);

    // Another Market's system actor never sees it; a mismatched order id answers nothing.
    const elsewhere = await new SellerOrderReportFactsQuery(gate, deps).execute(otherSystem(), {
      sellerOrders: [{ orderId: o.orderId, sellerOrderId: o.sellerOrderId }],
    });
    expect(elsewhere.ok && elsewhere.value).toEqual([]);
    const mismatched = await new SellerOrderReportFactsQuery(gate, deps).execute(system, {
      sellerOrders: [{ orderId: ids.next<'Order'>(), sellerOrderId: o.sellerOrderId }],
    });
    expect(mismatched.ok && mismatched.value).toEqual([]);
  });

  it('answers only a succeeded refund, with the Offer of each line', async () => {
    const sellerId = ids.next<'Seller'>();
    const done = await refunded(sellerId, 1, 'succeeded');
    const waiting = await refunded(sellerId, 1, 'pending');
    const facts = await new RefundReportFactsQuery(gate, deps).execute(system, {
      refundIds: [done.refundId, waiting.refundId],
    });
    if (!facts.ok) throw new Error(facts.error.code);
    expect(facts.value.map((fact) => fact.refundId)).toEqual([done.refundId]);
    const fact = facts.value[0]!;
    expect(fact).toMatchObject({ sellerOrderId: done.sellerOrderId, sellerId, currency });
    expect(fact.lines).toHaveLength(1);
    expect(fact.lines[0]?.quantity).toBe(1);
    expect(typeof fact.lines[0]?.offerId).toBe('string');
    expect(fact.refundedAt).not.toBeNull();
    // Positive totals, tax inside the amount; no shipping was refunded, so the total is the goods.
    const line = fact.lines[0]!.goods;
    expect(line.amount).toBeGreaterThan(0n);
    expect(line.tax).toBeGreaterThan(0n);
    expect(line.tax).toBeLessThan(line.amount);
    expect(fact.shipping).toEqual({ amount: 0n, tax: 0n });
    expect(fact.total).toEqual(line);
    // One unit of three: the inclusive line is 1100 with 100 tax.
    if (inclusive) expect(line).toEqual({ amount: 1100n, tax: 100n });

    // Another Market's system actor never sees it.
    const elsewhere = await new RefundReportFactsQuery(gate, deps).execute(otherSystem(), {
      refundIds: [done.refundId],
    });
    expect(elsewhere.ok && elsewhere.value).toEqual([]);
  });

  it('denies every reporting read to a human actor, admin or seller', async () => {
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );
    const at = clock.now();
    const page = { window: { from: null, to: at }, after: null, limit: 10 };
    for (const human of [admin, seller]) {
      const results = [
        await new SellerOrderReportFactsQuery(gate, deps).execute(human, { sellerOrders: [] }),
        await new RefundReportFactsQuery(gate, deps).execute(human, { refundIds: [] }),
        await new SellerOrdersChangedQuery(gate, changesDeps()).execute(human, page),
        await new RefundsSucceededQuery(gate, changesDeps()).execute(human, page),
      ];
      for (const result of results) expect(!result.ok && result.error.code).toBe('access.denied');
    }
  });

  it('pages the seller orders and refunds of a window by id, and nothing of another Market', async () => {
    const from = clock.now();
    const sellerId = ids.next<'Seller'>();
    const a = await refunded(sellerId, 1, 'succeeded');
    const b = await refunded(sellerId, 1, 'succeeded');
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    const to = clock.now();
    const window = { from, to };

    const mine = new Set([a.sellerOrderId, b.sellerOrderId]);
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 1000; guard += 1) {
      const page = await new SellerOrdersChangedQuery(gate, changesDeps()).execute(system, {
        window,
        after,
        limit: 1,
      });
      if (!page.ok) throw new Error(page.error.code);
      seen.push(...page.value.items.map((item) => item.sellerOrderId));
      if (page.value.next === null) break;
      after = page.value.next;
    }
    expect(seen.filter((id) => mine.has(id as Id<'SellerOrder'>)).sort()).toEqual([...mine].sort());
    expect([...seen].sort()).toEqual(seen);
    const otherOrders = await new SellerOrdersChangedQuery(gate, changesDeps()).execute(
      otherSystem(),
      { window, after: null, limit: 500 },
    );
    if (!otherOrders.ok) throw new Error(otherOrders.error.code);
    expect(otherOrders.value.items.some((item) => mine.has(item.sellerOrderId))).toBe(false);

    const refunds = await new RefundsSucceededQuery(gate, changesDeps()).execute(system, {
      window,
      after: null,
      limit: 500,
    });
    if (!refunds.ok) throw new Error(refunds.error.code);
    expect(refunds.value.items).toEqual(expect.arrayContaining([a.refundId, b.refundId]));

    const later = await new RefundsSucceededQuery(gate, changesDeps()).execute(system, {
      window: { from: to, to: to.add({ hours: 1 }) },
      after: null,
      limit: 500,
    });
    expect(later.ok && later.value.items).not.toEqual(expect.arrayContaining([a.refundId]));
    const elsewhere = await new RefundsSucceededQuery(gate, changesDeps()).execute(otherSystem(), {
      window,
      after: null,
      limit: 500,
    });
    expect(elsewhere.ok && elsewhere.value.items).not.toEqual(expect.arrayContaining([a.refundId]));
  });

  it('refuses a backwards window, a bad cursor and an oversized page', async () => {
    const at = clock.now();
    const query = new SellerOrdersChangedQuery(gate, changesDeps());
    for (const request of [
      { window: { from: at, to: at }, after: null, limit: 10 },
      { window: { from: null, to: at }, after: 'nope', limit: 10 },
      { window: { from: null, to: at }, after: null, limit: 501 },
    ]) {
      const result = await query.execute(system, request);
      expect(!result.ok && result.error.code).toBe('validation.failed');
    }
  });
});
