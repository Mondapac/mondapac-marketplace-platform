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
import type {
  RefundListFilter,
  RefundSort,
} from '../../src/modules/ordering/domain/admin-refund-list';
import { AdminListRefunds } from '../../src/modules/ordering/application/use-cases/admin-list-refunds.use-case';
import { AdminRefundOrder } from '../../src/modules/ordering/application/use-cases/admin-refund-order.use-case';
import { ConfirmPayment } from '../../src/modules/ordering/application/use-cases/confirm-payment.use-case';
import { ORDERING_AUDIT_ACTIONS } from '../../src/modules/ordering/domain/audit';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { ConfigOrderingPolicy } from '../../src/modules/ordering/infrastructure/config-ordering-policy';
import { PrismaAdminRefundListReader } from '../../src/modules/ordering/infrastructure/prisma-admin-refund-list.reader';
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

// The admin Refunds list on PostgreSQL, as the application role, for both Market fixtures: the
// filters (each one alone and the state + ledger pair), the search by customer or store, the
// exact references (refund, order, seller order, Stripe id), the sorts with their tie, the paging
// with its total, the row actions and credit note, and that another Market's refunds never show.
// Other files write refunds into the same database at the same time, so every read here is scoped
// to this file's own sellers, and the per-state counts are only compared with a lower bound.

const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class RefundsOn extends ConfigOrderingPolicy {
  override refundsEnabled(): boolean {
    return true;
  }
}

const NO_FILTER: RefundListFilter = {
  ids: null,
  state: null,
  reference: null,
  stripeRefundId: null,
  reason: null,
  actor: null,
  lossBearer: null,
  ledger: null,
  sellerId: null,
  from: null,
  to: null,
  minAmount: null,
  maxAmount: null,
  parties: null,
};

describe.each(TEST_MARKETS)('admin refund list in market %s (database)', (code) => {
  const market = marketOf(code);
  const inclusive = code === 'AU';
  const currency = inclusive ? 'AUD' : 'JPY';
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let gateway: FakeGateway;
  let deps: OrderingDependencies;
  let reader: PrismaAdminRefundListReader;
  let admin: CallContext;
  let system: CallContext;
  let audit: AuditWriter;

  beforeAll(() => {
    db = createPersistence();
    reader = new PrismaAdminRefundListReader(db.service);
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
          cancelledAt: null,
          ledgerState: 'pending',
          deliveryMethod: 'instant',
          deliveryWindow: null,
          readyAt: null,
          readyPrepMinutes: null,
          deliveryAttention: null,
          buyerFirst: null,
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
    // Stripe refused it: the refund is kept as failed, and the admin is told.
    if (answer !== 'failed' || result.error.code !== 'ordering.refund-rejected') {
      throw new Error(`could not refund: ${result.error.code}`);
    }
    const rows = await read({ reference: o.sellerOrderId });
    if (!rows.ok || rows.value.length !== 1) throw new Error('the failed refund is not stored');
    return { ...o, refundId: rows.value[0]!.refundId };
  };

  const read = (
    filter: Partial<RefundListFilter>,
    sort: RefundSort = { key: 'requested', direction: 'desc' },
  ) =>
    db.unitOfWork.run(
      market,
      async () => ok(await reader.page(market, { ...NO_FILTER, ...filter }, sort, 0, 50)),
      { readOnly: true },
    );
  const count = (filter: Partial<RefundListFilter>) =>
    db.unitOfWork.run(
      market,
      async () => ok(await reader.count(market, { ...NO_FILTER, ...filter })),
      {
        readOnly: true,
      },
    );
  const idsOf = async (filter: Partial<RefundListFilter>, sort?: Parameters<typeof read>[1]) => {
    const rows = await read(filter, sort);
    if (!rows.ok) throw new Error('read failed');
    return rows.value.map((row) => row.refundId);
  };

  it('lists one row per refund, newest first, with its amounts, state, actions and credit note', async () => {
    const sellerId = ids.next<'Seller'>();
    const first = await refunded(sellerId, 1, 'succeeded');
    const second = await refunded(sellerId, 2, 'pending');
    const third = await refunded(sellerId, 3, 'failed');

    const rows = await read({ sellerId });
    if (!rows.ok) throw new Error('read failed');
    expect(rows.value.map((r) => r.refundId)).toEqual([
      third.refundId,
      second.refundId,
      first.refundId,
    ]);
    const done = rows.value[2]!;
    expect(done).toMatchObject({
      orderId: first.orderId,
      sellerOrderId: first.sellerOrderId,
      sellerId,
      accountId: first.accountId,
      reason: 'damaged',
      actor: 'admin',
      state: 'succeeded',
      lossBearer: 'seller',
      lossReasonCode: null,
      ledgerRecordedAt: null,
    });
    expect(done.gross.currency).toBe(currency);
    expect(done.gross.amount).toBeGreaterThan(0n);
    expect(done.stripeRefundId).toMatch(/^re_test_/);
    expect(done.creditNoteId).not.toBeNull();
    expect(rows.value[1]!.state).toBe('pending');
    expect(rows.value[0]!.state).toBe('failed');
    expect(rows.value[0]!.creditNoteId).toBeNull();
    // Three units refunded give back more than one.
    expect(rows.value[0]!.gross.amount).toBeGreaterThan(done.gross.amount);

    const counted = await count({ sellerId });
    expect(counted.ok && counted.value).toBe(3);
    const byState = await db.unitOfWork.run(
      market,
      async () => ok(await reader.countByState(market)),
      {
        readOnly: true,
      },
    );
    if (!byState.ok) throw new Error('count failed');
    expect(byState.value.succeeded).toBeGreaterThanOrEqual(1);
    expect(byState.value.pending).toBeGreaterThanOrEqual(1);
    expect(byState.value.failed).toBeGreaterThanOrEqual(1);
  });

  it('filters by state, reason, loss bearer, ledger, amount and request time', async () => {
    const sellerId = ids.next<'Seller'>();
    const start = clock.now();
    const small = await refunded(sellerId, 1, 'succeeded', { reason: 'wrong-item' });
    const middle = clock.now();
    const big = await refunded(sellerId, 3, 'pending', { platform: true });

    expect(await idsOf({ sellerId, state: 'pending' })).toEqual([big.refundId]);
    expect(await idsOf({ sellerId, reason: 'wrong-item' })).toEqual([small.refundId]);
    expect(await idsOf({ sellerId, lossBearer: 'platform' })).toEqual([big.refundId]);
    expect(await idsOf({ sellerId, ledger: 'waiting' })).toEqual([small.refundId]);
    expect(await idsOf({ sellerId, ledger: 'recorded' })).toEqual([]);
    // The ledger filter narrows a state filter beside it; it never replaces it.
    expect(await idsOf({ sellerId, ledger: 'waiting', state: 'failed' })).toEqual([]);
    expect(await idsOf({ sellerId, actor: 'seller' })).toEqual([]);
    const rows = await read({ sellerId });
    if (!rows.ok) throw new Error('read failed');
    const smallGross = rows.value.find((r) => r.refundId === small.refundId)!.gross.amount;
    expect(await idsOf({ sellerId, maxAmount: smallGross })).toEqual([small.refundId]);
    expect(await idsOf({ sellerId, minAmount: smallGross + 1n })).toEqual([big.refundId]);
    expect(await idsOf({ sellerId, from: middle })).toEqual([big.refundId]);
    expect(await idsOf({ sellerId, from: start, to: middle })).toEqual([small.refundId]);

    // Once the worker writes the refund into the seller ledger, it moves to Recorded.
    const recorded = await db.unitOfWork.run(market, async () => {
      await db.service.tx(market).orderingRefund.updateMany({
        where: { marketId: market.marketId, id: small.refundId },
        data: { ledgerRecordedAt: new Date(clock.now().epochMilliseconds) },
      });
      return ok(undefined);
    });
    if (!recorded.ok) throw new Error('could not record the ledger');
    expect(await idsOf({ sellerId, ledger: 'recorded' })).toEqual([small.refundId]);
    expect(await idsOf({ sellerId, ledger: 'waiting' })).toEqual([]);
    expect(await idsOf({ sellerId, ledger: 'recorded', state: 'succeeded' })).toEqual([
      small.refundId,
    ]);
  });

  it('narrows to the selected refunds of an export, beside the filter', async () => {
    const sellerId = ids.next<'Seller'>();
    const a = await refunded(sellerId, 1, 'succeeded');
    await refunded(sellerId, 1, 'succeeded');
    const c = await refunded(sellerId, 1, 'pending');
    expect(await idsOf({ sellerId, ids: [a.refundId, c.refundId] })).toEqual([
      c.refundId,
      a.refundId,
    ]);
    expect(await idsOf({ ids: [a.refundId, c.refundId], state: 'pending' })).toEqual([c.refundId]);
    expect(await idsOf({ ids: [ids.next<'Refund'>()] })).toEqual([]);
  });

  it('finds a refund by its id, its order, its seller order or its Stripe id', async () => {
    const sellerId = ids.next<'Seller'>();
    const target = await refunded(sellerId, 1, 'succeeded');
    await refunded(sellerId, 1, 'succeeded');
    for (const reference of [target.refundId, target.orderId, target.sellerOrderId]) {
      expect(await idsOf({ reference })).toEqual([target.refundId]);
    }
    const rows = await read({ reference: target.refundId });
    if (!rows.ok) throw new Error('read failed');
    expect(await idsOf({ stripeRefundId: rows.value[0]!.stripeRefundId })).toEqual([
      target.refundId,
    ]);
    expect(await idsOf({ reference: ids.next<'Order'>() })).toEqual([]);
  });

  it('matches the search by customer account or by store, and nothing for empty lists', async () => {
    const sellerA = ids.next<'Seller'>();
    const sellerB = ids.next<'Seller'>();
    const customer = ids.next<'Account'>();
    const byCustomer = await refunded(sellerA, 1, 'succeeded', { accountId: customer });
    const byStore = await refunded(sellerB, 1, 'succeeded');
    await refunded(sellerA, 1, 'succeeded');

    expect(await idsOf({ parties: { accountIds: [customer], sellerIds: [sellerB] } })).toEqual([
      byStore.refundId,
      byCustomer.refundId,
    ]);
    expect(await idsOf({ parties: { accountIds: [], sellerIds: [] } })).toEqual([]);
  });

  it('sorts by amount and by settle time with the id as the tie, pending refunds last', async () => {
    const sellerId = ids.next<'Seller'>();
    const one = await refunded(sellerId, 1, 'succeeded');
    const three = await refunded(sellerId, 3, 'succeeded');
    const pending = await refunded(sellerId, 2, 'pending');

    expect(await idsOf({ sellerId }, { key: 'amount', direction: 'asc' })).toEqual([
      one.refundId,
      pending.refundId,
      three.refundId,
    ]);
    expect(await idsOf({ sellerId }, { key: 'settled', direction: 'desc' })).toEqual([
      three.refundId,
      one.refundId,
      pending.refundId,
    ]);
    expect(await idsOf({ sellerId }, { key: 'settled', direction: 'asc' })).toEqual([
      one.refundId,
      three.refundId,
      pending.refundId,
    ]);
  });

  it('answers a page with its total and per-row actions through the use case', async () => {
    const sellerId = ids.next<'Seller'>();
    for (let i = 0; i < 3; i += 1) await refunded(sellerId, 1, i === 0 ? 'pending' : 'succeeded');
    const list = new AdminListRefunds(gate, {
      unitOfWork: db.unitOfWork,
      refunds: reader,
      labels: new FakeLabels(),
    });
    const page = await list.execute(admin, { sellerId, page: 2, pageSize: 2 });
    if (!page.ok) throw new Error(page.error.code);
    expect(page.value).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page.value.rows).toHaveLength(1);
    // The oldest refund was the pending one: Stripe made it (it has an id) but has not settled it.
    expect(page.value.rows[0]!.state).toBe('pending');
    expect(page.value.rows[0]!.actions).toEqual(['view-order', 'copy-stripe-reference']);
    const first = await list.execute(admin, { sellerId, pageSize: 2 });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.rows.map((r) => r.actions)).toEqual([
      ['view-order', 'copy-stripe-reference'],
      ['view-order', 'copy-stripe-reference'],
    ]);
  });

  it('walks Previous/Next pages newest request first with a keyset cursor', async () => {
    const sellerId = ids.next<'Seller'>();
    const made = [];
    for (let i = 0; i < 3; i += 1) made.push(await refunded(sellerId, 1, 'succeeded'));
    const list = new AdminListRefunds(gate, {
      unitOfWork: db.unitOfWork,
      refunds: reader,
      labels: new FakeLabels(),
    });
    const one = await list.execute(admin, { sellerId, limit: 2 });
    if (!one.ok) throw new Error(one.error.code);
    expect(one.value.total).toBeNull();
    expect(one.value.rows.map((r) => r.refundId)).toEqual([made[2]!.refundId, made[1]!.refundId]);
    const two = await list.execute(admin, { sellerId, limit: 2, cursor: one.value.nextCursor });
    if (!two.ok) throw new Error(two.error.code);
    expect(two.value.rows.map((r) => r.refundId)).toEqual([made[0]!.refundId]);
    expect(two.value.nextCursor).toBeNull();
  });

  it('walks refunds requested at the same instant by id, skipping and repeating none', async () => {
    const sellerId = ids.next<'Seller'>();
    const older = await refunded(sellerId, 1, 'succeeded');
    const tied = [];
    for (let i = 0; i < 3; i += 1) {
      tied.push(await refunded(sellerId, 1, 'succeeded', { sameInstant: i < 2 }));
    }
    const newer = await refunded(sellerId, 1, 'succeeded');
    const list = new AdminListRefunds(gate, {
      unitOfWork: db.unitOfWork,
      refunds: reader,
      labels: new FakeLabels(),
    });
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let step = 0; step < 6; step += 1) {
      const page = await list.execute(admin, { sellerId, limit: 1, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(page.error.code);
      seen.push(...page.value.rows.map((r) => r.refundId));
      cursor = page.value.nextCursor;
      if (cursor === null) break;
    }
    // Ties on requested_at fall back to the id, newest first (uuid order is byte order).
    const tiedDesc = tied
      .map((r) => r.refundId as string)
      .sort()
      .reverse();
    expect(seen).toEqual([newer.refundId, ...tiedDesc, older.refundId]);
  });

  it("never shows another Market's refunds", async () => {
    const sellerId = ids.next<'Seller'>();
    const mine = await refunded(sellerId, 1, 'succeeded');
    const other = marketOf(TEST_MARKETS.find((m) => m !== code)!);
    const rows = await db.unitOfWork.run(
      other,
      async () =>
        ok(
          await reader.page(
            other,
            { ...NO_FILTER, reference: mine.refundId },
            { key: 'requested', direction: 'desc' },
            0,
            10,
          ),
        ),
      { readOnly: true },
    );
    expect(rows.ok && rows.value).toEqual([]);
    // Nor through an export's selected ids.
    const selected = await db.unitOfWork.run(
      other,
      async () =>
        ok(
          await reader.page(
            other,
            { ...NO_FILTER, ids: [mine.refundId] },
            { key: 'requested', direction: 'desc' },
            0,
            10,
          ),
        ),
      { readOnly: true },
    );
    expect(selected.ok && selected.value).toEqual([]);
  });
});
