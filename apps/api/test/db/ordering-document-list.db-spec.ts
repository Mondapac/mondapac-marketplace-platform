import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import type { OrderingDependencies } from '../../src/modules/ordering/application/checkout-flow';
import type {
  DocumentListFilter,
  DocumentSort,
} from '../../src/modules/ordering/domain/admin-document-list';
import { AdminListDocuments } from '../../src/modules/ordering/application/use-cases/admin-list-documents.use-case';
import { AdminRefundOrder } from '../../src/modules/ordering/application/use-cases/admin-refund-order.use-case';
import { ConfirmPayment } from '../../src/modules/ordering/application/use-cases/confirm-payment.use-case';
import { ORDERING_AUDIT_ACTIONS } from '../../src/modules/ordering/domain/audit';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { ConfigOrderingPolicy } from '../../src/modules/ordering/infrastructure/config-ordering-policy';
import { PrismaAdminDocumentListReader } from '../../src/modules/ordering/infrastructure/prisma-admin-document-list.reader';
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
import { documentListPageBody } from '../../src/modules/ordering/presentation/admin-document-list.dto';

// The admin Invoices list on PostgreSQL, as the application role, for both Market fixtures (owner
// decision 2026-11-15: order confirmations and credit notes until numbered invoices exist): one
// kind per read, only paid seller orders and succeeded refunds, the frozen tax of a confirmation,
// the filters and exact references, the search, the sorts, the paging with its total, the row
// actions, and that another Market's documents never show. Other files write orders and refunds
// into the same database at the same time, so every read here is scoped to this file's own
// sellers, and the per-kind counts are only compared with a lower bound.

const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class RefundsOn extends ConfigOrderingPolicy {
  override refundsEnabled(): boolean {
    return true;
  }
}

const CONFIRMATIONS: DocumentListFilter = {
  ids: null,
  kind: 'order-confirmation',
  reference: null,
  sellerId: null,
  from: null,
  to: null,
  minAmount: null,
  maxAmount: null,
  parties: null,
};
const CREDIT_NOTES: DocumentListFilter = { ...CONFIRMATIONS, kind: 'credit-note' };
const NEWEST: DocumentSort = { key: 'issued', direction: 'desc' };

describe.each(TEST_MARKETS)('admin document list in market %s (database)', (code) => {
  const market = marketOf(code);
  const inclusive = code === 'AU';
  const currency = inclusive ? 'AUD' : 'JPY';
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let gateway: FakeGateway;
  let deps: OrderingDependencies;
  let reader: PrismaAdminDocumentListReader;
  let admin: CallContext;
  let system: CallContext;
  let audit: AuditWriter;

  beforeAll(() => {
    db = createPersistence();
    reader = new PrismaAdminDocumentListReader(db.service);
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
      policy: new RefundsOn(markets),
      cart: new FakeCart(),
      customers: new FakeCustomers(),
      shipTo: new FakeShipToCipher(),
      inventory: new FakeInventory(),
      shipping: new FakeShipping(),
      commission: new FakeCommission(),
      tax: new FakeTax(),
      taxCategories: new FakeTaxCategories('taxable'),
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

  /** The delivery fee as the buyer paid it: the fee, plus its tax where it was excluded. */
  const shippingPaid = inclusive ? shipping : shipping + shippingTax;

  /**
   * A paid order of one seller with one line of `units` units of 11.00 (or 1100), three by
   * default. `oldShipping`: placed before the delivery fee's tax was recorded (all three null).
   * `oldLineTax`: the line was placed before its tax was recorded (rate, amount and code null).
   */
  const paidOrder = async (
    sellerId: Id<'Seller'>,
    accountId = ids.next<'Account'>(),
    options: { units?: number; oldShipping?: boolean; oldLineTax?: boolean } = {},
  ) => {
    const units = options.units ?? 3;
    const old = options.oldShipping === true;
    const goods = 1100n * BigInt(units);
    const taxOfLine = units === 3 ? lineTax : (inclusive ? 100n : 150n) * BigInt(units);
    const feeTax = old ? 0n : shippingTax;
    const orderTotal = inclusive ? goods + shipping : goods + taxOfLine + shipping + feeTax;
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
      total: money(orderTotal, currency),
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
          subtotal: goods,
          shipping,
          shippingTaxRateBps: old ? null : inclusive ? 1000 : 1500,
          shippingTax: old ? null : shippingTax,
          shippingTaxInclusive: old ? null : inclusive,
          total: orderTotal,
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
          quantity: units,
          unitPrice: money(1100n, currency),
          lineAmount: goods,
          taxInclusive: inclusive,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
          taxRateBps: options.oldLineTax === true ? null : inclusive ? 1000 : 1500,
          taxAmount: options.oldLineTax === true ? null : taxOfLine,
          taxCategoryCode:
            options.oldLineTax === true ? null : inclusive ? 'taxable' : 'zz_standard',
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
    return { orderId, sellerOrderId, lineId, accountId, total: orderTotal };
  };

  /**
   * A refund of `units` units, ending as Stripe answers; the clock moves a minute after it unless
   * `sameInstant` keeps it (to issue several documents at one time).
   */
  const refunded = async (
    sellerId: Id<'Seller'>,
    units: number,
    answer: 'succeeded' | 'pending',
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
    if (!result.ok) throw new Error(`could not refund: ${result.error.code}`);
    return { ...o, refundId: result.value.refundId };
  };

  const idsOf = async (filter: Partial<DocumentListFilter>, sort: DocumentSort = NEWEST) => {
    const rows = await db.unitOfWork.run(
      market,
      async () => ok(await reader.page(market, { ...CONFIRMATIONS, ...filter }, sort, 0, 50)),
      { readOnly: true },
    );
    if (!rows.ok) throw new Error('read failed');
    return rows.value;
  };

  it('lists a confirmation per paid seller order with its frozen tax, newest first', async () => {
    const sellerId = ids.next<'Seller'>();
    const first = await paidOrder(sellerId);
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    const second = await paidOrder(sellerId);
    const rows = await idsOf({ sellerId });
    expect(rows.map((r) => r.documentId)).toEqual([second.sellerOrderId, first.sellerOrderId]);
    expect(rows[1]).toMatchObject({
      kind: 'order-confirmation',
      orderId: first.orderId,
      sellerOrderId: first.sellerOrderId,
      accountId: first.accountId,
      total: { amount: total, currency },
      tax: { amount: lineTax + shippingTax, currency },
      // As paid: in a Market whose prices exclude tax, the fee plus its tax.
      shipping: { amount: shippingPaid, currency },
      refundId: null,
      refundReason: null,
    });
  });

  it('lists a credit note per succeeded refund only, with its refund', async () => {
    const sellerId = ids.next<'Seller'>();
    const done = await refunded(sellerId, 1, 'succeeded', { reason: 'wrong-item' });
    await refunded(sellerId, 1, 'pending');
    const rows = await idsOf({ kind: 'credit-note', sellerId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'credit-note',
      refundId: done.refundId,
      orderId: done.orderId,
      sellerOrderId: done.sellerOrderId,
      accountId: done.accountId,
      refundReason: 'wrong-item',
    });
    expect(rows[0]!.total.amount).toBeGreaterThan(0n);
    expect(rows[0]!.tax?.amount).toBeGreaterThan(0n);
    // Both paid orders still have their confirmation.
    expect(await idsOf({ sellerId })).toHaveLength(2);
    for (const reference of [
      done.refundId,
      done.orderId,
      done.sellerOrderId,
      rows[0]!.documentId,
    ]) {
      expect((await idsOf({ kind: 'credit-note', reference })).map((r) => r.refundId)).toEqual([
        done.refundId,
      ]);
    }
  });

  it('narrows each kind to the selected documents of an export', async () => {
    const sellerId = ids.next<'Seller'>();
    const done = await refunded(sellerId, 1, 'succeeded');
    const other = await refunded(sellerId, 1, 'succeeded');
    const notes = await idsOf({ kind: 'credit-note', sellerId });
    const note = notes.find((row) => row.refundId === done.refundId)!;
    expect(
      (await idsOf({ kind: 'credit-note', ids: [note.documentId] })).map((r) => r.refundId),
    ).toEqual([done.refundId]);
    expect(
      (await idsOf({ sellerId, ids: [other.sellerOrderId] })).map((r) => r.documentId),
    ).toEqual([other.sellerOrderId]);
    // A seller order id is not a credit note id: the kinds never mix.
    expect(await idsOf({ kind: 'credit-note', ids: [done.sellerOrderId] })).toEqual([]);
  });

  it('filters by issue time, amount and party, and sorts by amount', async () => {
    const sellerA = ids.next<'Seller'>();
    const sellerB = ids.next<'Seller'>();
    const customer = ids.next<'Account'>();
    const start = clock.now();
    const a = await paidOrder(sellerA, customer, { units: 1 });
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    const middle = clock.now();
    const b = await paidOrder(sellerB);
    const both = { parties: { accountIds: [customer], sellerIds: [sellerB] } };
    expect((await idsOf(both)).map((r) => r.documentId)).toEqual([
      b.sellerOrderId,
      a.sellerOrderId,
    ]);
    expect((await idsOf({ ...both, from: start, to: middle })).map((r) => r.documentId)).toEqual([
      a.sellerOrderId,
    ]);
    expect(a.total).toBeLessThan(b.total);
    expect(await idsOf({ ...both, minAmount: b.total + 1n })).toEqual([]);
    expect((await idsOf({ ...both, minAmount: b.total })).map((r) => r.documentId)).toEqual([
      b.sellerOrderId,
    ]);
    expect((await idsOf({ ...both, maxAmount: a.total })).map((r) => r.documentId)).toEqual([
      a.sellerOrderId,
    ]);
    // The cheaper order was paid first: the amount sort and the issue sort disagree.
    expect(
      (await idsOf(both, { key: 'amount', direction: 'asc' })).map((r) => r.documentId),
    ).toEqual([a.sellerOrderId, b.sellerOrderId]);
    expect(
      (await idsOf(both, { key: 'amount', direction: 'desc' })).map((r) => r.documentId),
    ).toEqual([b.sellerOrderId, a.sellerOrderId]);
    expect(await idsOf({ parties: { accountIds: [], sellerIds: [] } })).toEqual([]);
  });

  it('takes a confirmation tax by the order page rules, also before the fee tax was recorded', async () => {
    const sellerId = ids.next<'Seller'>();
    const old = await paidOrder(sellerId, undefined, { oldShipping: true });
    const [row] = await idsOf({ reference: old.sellerOrderId });
    // No recorded fee tax counts as none (shippingTaxOf), never as an unknown tax.
    expect(row).toMatchObject({
      tax: { amount: lineTax, currency },
      shipping: { amount: shipping, currency },
      total: { amount: old.total, currency },
    });
  });

  it('filters and sorts credit notes by issue time, amount, store and customer', async () => {
    const sellerA = ids.next<'Seller'>();
    const sellerB = ids.next<'Seller'>();
    const customer = ids.next<'Account'>();
    const start = clock.now();
    const small = await refunded(sellerA, 1, 'succeeded', { accountId: customer });
    const middle = clock.now();
    const big = await refunded(sellerB, 2, 'succeeded');
    const notes = await idsOf({
      kind: 'credit-note',
      parties: { accountIds: [customer], sellerIds: [sellerB] },
    });
    expect(notes.map((r) => r.refundId)).toEqual([big.refundId, small.refundId]);
    const [smallNote, bigNote] = [notes[1]!, notes[0]!];
    expect(smallNote.total.amount).toBeLessThan(bigNote.total.amount);
    // The customer is reached through the refund's seller order and its order.
    expect(
      (
        await idsOf({ kind: 'credit-note', parties: { accountIds: [customer], sellerIds: [] } })
      ).map((r) => r.refundId),
    ).toEqual([small.refundId]);
    const scope = {
      kind: 'credit-note' as const,
      parties: { accountIds: [customer], sellerIds: [sellerB] },
    };
    expect((await idsOf({ ...scope, from: start, to: middle })).map((r) => r.refundId)).toEqual([
      small.refundId,
    ]);
    expect(
      (await idsOf({ ...scope, minAmount: bigNote.total.amount })).map((r) => r.refundId),
    ).toEqual([big.refundId]);
    expect(
      (await idsOf({ ...scope, maxAmount: smallNote.total.amount })).map((r) => r.refundId),
    ).toEqual([small.refundId]);
    expect(
      (await idsOf(scope, { key: 'amount', direction: 'desc' })).map((r) => r.refundId),
    ).toEqual([big.refundId, small.refundId]);
    expect(
      (await idsOf(scope, { key: 'issued', direction: 'asc' })).map((r) => r.refundId),
    ).toEqual([small.refundId, big.refundId]);
  });

  it('walks Previous/Next pages of both kinds with a keyset cursor', async () => {
    const sellerId = ids.next<'Seller'>();
    const first = await refunded(sellerId, 1, 'succeeded');
    const second = await refunded(sellerId, 1, 'succeeded');
    const third = await refunded(sellerId, 1, 'succeeded');
    const list = new AdminListDocuments(gate, {
      unitOfWork: db.unitOfWork,
      documents: reader,
      labels: new FakeLabels(),
    });
    for (const kind of ['order-confirmation', 'credit-note'] as const) {
      const pick = (r: { sellerOrderId: string }) => r.sellerOrderId;
      const one = await list.execute(admin, { kind, sellerId, limit: 2 });
      if (!one.ok) throw new Error(one.error.code);
      expect(one.value.total).toBeNull();
      expect(one.value.rows.map(pick)).toEqual([third.sellerOrderId, second.sellerOrderId]);
      const two = await list.execute(admin, {
        kind,
        sellerId,
        limit: 2,
        cursor: one.value.nextCursor,
      });
      if (!two.ok) throw new Error(two.error.code);
      expect(two.value.rows.map(pick)).toEqual([first.sellerOrderId]);
      expect(two.value.nextCursor).toBeNull();
    }
  });

  it('walks documents issued at the same instant by id, for both kinds, skipping and repeating none', async () => {
    const sellerId = ids.next<'Seller'>();
    const older = await refunded(sellerId, 1, 'succeeded');
    const tied = [];
    for (let i = 0; i < 3; i += 1) {
      tied.push(await refunded(sellerId, 1, 'succeeded', { sameInstant: i < 2 }));
    }
    const newer = await refunded(sellerId, 1, 'succeeded');
    const list = new AdminListDocuments(gate, {
      unitOfWork: db.unitOfWork,
      documents: reader,
      labels: new FakeLabels(),
    });
    for (const kind of ['order-confirmation', 'credit-note'] as const) {
      const seen: { documentId: string; sellerOrderId: string }[] = [];
      let cursor: string | null | undefined;
      for (let step = 0; step < 6; step += 1) {
        const page = await list.execute(admin, {
          kind,
          sellerId,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        if (!page.ok) throw new Error(page.error.code);
        seen.push(...page.value.rows);
        cursor = page.value.nextCursor;
        if (cursor === null) break;
      }
      // The tied documents come by id, newest first (uuid order is byte order), each once.
      const tiedOrders = new Set(tied.map((t) => t.sellerOrderId as string));
      const middle = seen.slice(1, 4);
      expect(seen).toHaveLength(5);
      expect(seen[0]!.sellerOrderId).toBe(newer.sellerOrderId);
      expect(seen[4]!.sellerOrderId).toBe(older.sellerOrderId);
      expect(new Set(middle.map((d) => d.sellerOrderId))).toEqual(tiedOrders);
      const middleIds = middle.map((d) => d.documentId);
      expect(middleIds).toEqual([...middleIds].sort().reverse());
    }
  });

  it('shows no confirmation tax when a line was placed before its tax was recorded', async () => {
    const sellerId = ids.next<'Seller'>();
    const old = await paidOrder(sellerId, undefined, { oldLineTax: true });
    const [row] = await idsOf({ reference: old.sellerOrderId });
    expect(row).toMatchObject({ tax: null, total: { amount: old.total, currency } });
    const list = new AdminListDocuments(gate, {
      unitOfWork: db.unitOfWork,
      documents: reader,
      labels: new FakeLabels(),
    });
    const page = await list.execute(admin, { sellerId });
    if (!page.ok) throw new Error(page.error.code);
    // The response says null, never a zero tax.
    expect(documentListPageBody(page.value).documents.map((d) => d.tax)).toEqual([null]);
  });

  it('answers a page with its total, kind counts and row actions through the use case', async () => {
    const sellerId = ids.next<'Seller'>();
    await refunded(sellerId, 1, 'succeeded');
    await paidOrder(sellerId);
    const list = new AdminListDocuments(gate, {
      unitOfWork: db.unitOfWork,
      documents: reader,
      labels: new FakeLabels(),
    });
    const confirmations = await list.execute(admin, { sellerId });
    if (!confirmations.ok) throw new Error(confirmations.error.code);
    expect(confirmations.value).toMatchObject({ total: 2, page: 1 });
    expect(confirmations.value.rows.map((r) => [r.documentNumber, r.actions])).toEqual([
      [null, ['view-order', 'download-order-document']],
      [null, ['view-order', 'download-order-document']],
    ]);
    expect(confirmations.value.counts.orderConfirmations).toBeGreaterThanOrEqual(2);
    expect(confirmations.value.counts.creditNotes).toBeGreaterThanOrEqual(1);
    const notes = await list.execute(admin, { sellerId, kind: 'credit-note' });
    if (!notes.ok) throw new Error(notes.error.code);
    expect(notes.value.rows.map((r) => r.actions)).toEqual([['view-order']]);
  });

  it("never shows another Market's documents", async () => {
    const sellerId = ids.next<'Seller'>();
    const mine = await refunded(sellerId, 1, 'succeeded');
    const other = marketOf(TEST_MARKETS.find((m) => m !== code)!);
    for (const filter of [CONFIRMATIONS, CREDIT_NOTES]) {
      const rows = await db.unitOfWork.run(
        other,
        async () =>
          ok(await reader.page(other, { ...filter, reference: mine.orderId }, NEWEST, 0, 10)),
        { readOnly: true },
      );
      expect(rows.ok && rows.value).toEqual([]);
    }
    // Nor through an export's selected ids, of either kind.
    const selected = await db.unitOfWork.run(
      other,
      async () =>
        ok(
          await reader.page(other, { ...CONFIRMATIONS, ids: [mine.sellerOrderId] }, NEWEST, 0, 10),
        ),
      { readOnly: true },
    );
    expect(selected.ok && selected.value).toEqual([]);
  });
});
