import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { OrderingDependencies } from '../../src/modules/ordering/application/checkout-flow';
import { adminRefund } from '../../src/modules/ordering/application/refund-flow';
import { AdminRefundOrder } from '../../src/modules/ordering/application/use-cases/admin-refund-order.use-case';
import type { CommissionPayoutsDependencies } from '../../src/modules/commission-payouts/application/commission-payouts-dependencies';
import { RecordRefund } from '../../src/modules/commission-payouts/application/use-cases/record-refund.use-case';
import { RecordSellerOrderPaid } from '../../src/modules/commission-payouts/application/use-cases/record-seller-order-paid.use-case';
import { totalsOf, type LedgerKind } from '../../src/modules/commission-payouts/domain/ledger';
import { ConfigCommissionPolicy } from '../../src/modules/commission-payouts/infrastructure/config-commission-policy';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import { PrismaSellerRateRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-seller-rate.repository';
import { RecordLedger } from '../../src/modules/ordering/application/use-cases/record-ledger.use-case';
import { RecordRefundLedger } from '../../src/modules/ordering/application/use-cases/record-refund-ledger.use-case';
import { ConfirmPayment } from '../../src/modules/ordering/application/use-cases/confirm-payment.use-case';
import { SettleRefunds } from '../../src/modules/ordering/application/use-cases/settle-refunds.use-case';
import { LOSS_BEARERS, LOSS_REASON_CODES } from '../../src/modules/ordering/domain/reason-codes';
import { ORDERING_AUDIT_ACTIONS } from '../../src/modules/ordering/domain/audit';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { ConfigOrderingPolicy } from '../../src/modules/ordering/infrastructure/config-ordering-policy';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
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
  FakeCart,
  FakeCommission,
  FakeCustomers,
  FakeGateway,
  FakeInventory,
  FakeLabels,
  FakeShipping,
  FakeShipToCipher,
  FakeTax,
  FakeTaxCategories,
} from '../support/ordering-fakes';
import { AllowAllDeliveryMethods } from '../../src/modules/ordering/infrastructure/allow-all-delivery-methods';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { orderingRefundsTestDatabaseUrl } from './test-database';

// Refunds of a paid seller order by an admin on PostgreSQL, as the application role, for both
// Market fixtures (tax step 3): off by the Market switch until it is turned on; the refund is
// written (and audited) before Stripe is called and settles succeeded (with a credit note) only on
// Stripe's `succeeded`, failed (the refunded sum goes back down), or pending (the worker reads a
// refund Stripe made back by id, and retries an unanswered one with the same key); the tax
// reversed sums exactly to the frozen tax; nothing is ever refunded past what was taken; and the
// database refuses what the app must never do: change amounts, touch a credit note, re-open a
// settled refund, or move the refunded sum away from its refunds.

const T0 = Temporal.Instant.from('2026-10-19T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

/** The Market configuration with `tax.refundCredit.enabled` turned on (the fixtures keep it off). */
class RefundsOn extends ConfigOrderingPolicy {
  override refundsEnabled(): boolean {
    return true;
  }
}

describe.each(TEST_MARKETS)('refunds in market %s (database)', (code) => {
  const market = marketOf(code);
  const inclusive = code === 'AU';
  const currency = inclusive ? 'AUD' : 'JPY';
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let sql: Client;
  let gateway: FakeGateway;
  let deps: OrderingDependencies;
  let commission: FakeCommission;
  let admin: CallContext;
  let system: CallContext;
  let audit: AuditWriter;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: orderingRefundsTestDatabaseUrl() });
    sql = new Client({ connectionString: orderingRefundsTestDatabaseUrl() });
    await sql.connect();
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
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  /**
   * The seller orders this file created. The ledger steps (`RecordLedger`, `RecordRefundLedger`)
   * work through a Market-wide queue, and other spec files write paid seller orders and refunds
   * into the same database at the same time: unscoped, a step here would record (or count a
   * refusal on) another file's rows, and another file could find its own queued row already taken.
   */
  const owned = new Set<string>();
  /** Larger than every queue a run builds, so filtering after the read drops none of ours. */
  const QUEUE_SCAN = 100_000;
  /** The two repositories, with their ledger queues narrowed to `owned`, in the same order. */
  const ownLedgerQueues = (orders: PrismaOrderRepository, refunds: PrismaRefundRepository) => {
    const ownOrders = Object.create(orders) as PrismaOrderRepository;
    ownOrders.findUnrecordedLedger = async (m, limit) =>
      (await orders.findUnrecordedLedger(m, QUEUE_SCAN))
        .filter((r) => owned.has(r.sellerOrder.id))
        .slice(0, limit);
    const ownRefunds = Object.create(refunds) as PrismaRefundRepository;
    ownRefunds.findUnrecordedLedger = async (m, limit) =>
      (await refunds.findUnrecordedLedger(m, QUEUE_SCAN))
        .filter((r) => owned.has(r.refund.sellerOrderId))
        .slice(0, limit);
    return { orders: ownOrders, refunds: ownRefunds };
  };
  beforeEach(() => {
    gateway = new FakeGateway();
    commission = new FakeCommission();
    deps = {
      unitOfWork: db.unitOfWork,
      ...ownLedgerQueues(
        new PrismaOrderRepository(db.service),
        new PrismaRefundRepository(db.service),
      ),
      gateway,
      policy: new RefundsOn(markets),
      cart: new FakeCart(),
      customers: new FakeCustomers(),
      shipTo: new FakeShipToCipher(),
      inventory: new FakeInventory(),
      shipping: new FakeShipping(),
      commission,
      tax: new FakeTax(),
      taxCategories: new FakeTaxCategories('taxable'),
      outbox: { append: () => Promise.resolve() },
      audit,
      ids,
      clock,
      labels: new FakeLabels(),
      deliveryMethods: new AllowAllDeliveryMethods(),
    };
  });

  // AU: 3 × 11.00 with 3.00 GST inside, delivery 5.50 with 0.50 inside (total 38.50).
  // ZZ: 3 × 1000 with 451 tax on top, delivery 500 with 75 on top (total 4026).
  const unit = 1100n;
  const lineTax = inclusive ? 300n : 451n;
  const shipping = inclusive ? 550n : 500n;
  const shippingTax = inclusive ? 50n : 75n;
  const total = inclusive ? 3300n + 550n : 3300n + 451n + 500n + 75n;

  /** A paid order of one seller with one line of three units; answers its ids. */
  const paidOrder = async () => {
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    const sellerId = ids.next<'Seller'>();
    const lineId = ids.next<'OrderLine'>();
    owned.add(sellerOrderId);
    const order: OrderState = {
      id: orderId,
      marketId: market.marketId,
      accountId: ids.next<'Account'>(),
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
          deliveryAttention: null,
        },
      ],
      lines: [
        {
          id: lineId,
          sellerOrderId,
          offerId: ids.next<'Offer'>(),
          variantId: ids.next<'Variant'>(),
          quantity: 3,
          unitPrice: money(unit, currency),
          lineAmount: 3300n,
          taxInclusive: inclusive,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
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
    gateway.refunds.length = 0;
    return { orderId, sellerOrderId, sellerId, lineId };
  };

  const refund = (
    o: { orderId: Id<'Order'>; sellerOrderId: Id<'SellerOrder'>; lineId: Id<'OrderLine'> },
    quantity: number,
    shippingAmount?: string,
    use: OrderingDependencies = deps,
    loss: { lossBearer?: unknown; lossReasonCode?: unknown } = {},
  ) =>
    new AdminRefundOrder(gate, use).execute(admin, {
      orderId: o.orderId,
      sellerOrderId: o.sellerOrderId,
      lines: quantity === 0 ? [] : [{ orderLineId: o.lineId, quantity }],
      shippingAmount,
      reason: 'damaged',
      ...loss,
    });

  const rowsOf = async (sellerOrderId: string) => ({
    refunded: (
      await sql.query<{ refunded_amount: string }>(
        'SELECT refunded_amount FROM ordering.seller_orders WHERE market_id = $1 AND id = $2',
        [market.marketId, sellerOrderId],
      )
    ).rows[0]?.refunded_amount,
    refunds: (
      await sql.query<{
        id: string;
        state: string;
        gross_amount: string;
        tax_amount: string;
        stripe_refund_id: string | null;
      }>(
        `SELECT id, state, gross_amount, tax_amount, stripe_refund_id FROM ordering.refunds
          WHERE market_id = $1 AND seller_order_id = $2 ORDER BY requested_at, id`,
        [market.marketId, sellerOrderId],
      )
    ).rows,
    notes: (
      await sql.query<{ gross_amount: string; tax_amount: string }>(
        `SELECT gross_amount, tax_amount FROM ordering.credit_notes
          WHERE market_id = $1 AND seller_order_id = $2 ORDER BY issued_at, id`,
        [market.marketId, sellerOrderId],
      )
    ).rows,
  });

  it('refuses while the Market switch is off: nothing written, Stripe never called', async () => {
    const o = await paidOrder();
    const off = { ...deps, policy: new ConfigOrderingPolicy(markets) };

    const result = await refund(o, 1, undefined, off);

    expect(result).toEqual({ ok: false, error: { code: 'ordering.refund-disabled' } });
    expect(gateway.refunds).toHaveLength(0);
    expect(await rowsOf(o.sellerOrderId)).toEqual({ refunded: '0', refunds: [], notes: [] });
    const settled = await new SettleRefunds(gate, off).execute(system, {});
    expect(settled).toEqual(ok({ succeeded: 0, failed: 0, stuck: [] }));
  });

  it('announces each refund Stripe confirmed, once, with ids only, and none it refused', async () => {
    const written: PendingEvent[] = [];
    const recording: OrderingDependencies = {
      ...deps,
      outbox: {
        append: (_context, events) => {
          written.push(...events);
          return Promise.resolve();
        },
      },
    };
    const o = await paidOrder();

    const done = await refund(o, 1, undefined, recording);
    expect(done.ok).toBe(true);
    expect(written).toEqual([
      expect.objectContaining({
        type: 'ordering.refund-succeeded.v1',
        payload: {
          orderId: o.orderId,
          sellerOrderId: o.sellerOrderId,
          refundId: done.ok ? done.value.refundId : '',
        },
      }),
    ]);

    gateway.refundFails = { code: 'payment.provider-rejected' };
    expect((await refund(o, 1, undefined, recording)).ok).toBe(false);
    expect(written).toHaveLength(1);
  });

  it('refunds in parts from the frozen values and reverses exactly the frozen tax', async () => {
    const o = await paidOrder();

    const first = await refund(o, 1, (shipping / 2n).toString());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstLineTax = inclusive ? 100n : 151n; // 451 over 3: 151, 150, 150
    const halfShippingGross = shipping / 2n;
    // The shipping as paid is the fee plus its tax when the fee excluded it (ZZ: 575).
    const shippingGross = inclusive ? shipping : shipping + shippingTax;
    const halfShippingTax =
      (shippingTax * halfShippingGross * 2n + shippingGross) / (shippingGross * 2n);
    expect(first.value).toMatchObject({
      state: 'succeeded',
      tax: money(firstLineTax + halfShippingTax, currency),
      lines: [{ orderLineId: o.lineId, quantity: 1, tax: money(firstLineTax, currency) }],
    });
    expect(first.value.creditNoteId).not.toBeNull();
    expect(gateway.refunds[0]).toMatchObject({
      paymentIntentId: `pi_${o.orderId.replaceAll('-', '')}`,
      amount: first.value.amount.amount,
      idempotencyKey: `refund-${first.value.refundId}`,
    });

    // More than is left is refused; the rest goes back and the sums close exactly.
    expect(await refund(o, 3)).toMatchObject({
      ok: false,
      error: { code: 'ordering.refund-exceeds' },
    });
    const restShipping = shippingGross - halfShippingGross;
    const rest = await refund(o, 2, restShipping.toString());
    expect(rest.ok).toBe(true);

    const rows = await rowsOf(o.sellerOrderId);
    expect(rows.refunded).toBe(total.toString());
    expect(rows.refunds.map((r) => r.state)).toEqual(['succeeded', 'succeeded']);
    const taxBack = rows.notes.reduce((sum, n) => sum + BigInt(n.tax_amount), 0n);
    const grossBack = rows.notes.reduce((sum, n) => sum + BigInt(n.gross_amount), 0n);
    expect(taxBack).toBe(lineTax + shippingTax);
    expect(grossBack).toBe(total);
    expect(await refund(o, 0, '1')).toMatchObject({ error: { code: 'ordering.refund-exceeds' } });
  });

  it('records a refused Stripe refund as failed and lowers the refunded sum again', async () => {
    const o = await paidOrder();
    gateway.refundFails = { code: 'payment.provider-rejected' };

    expect(await refund(o, 1)).toEqual({ ok: false, error: { code: 'ordering.refund-rejected' } });

    const rows = await rowsOf(o.sellerOrderId);
    expect(rows.refunded).toBe('0');
    expect(rows.refunds.map((r) => r.state)).toEqual(['failed']);
    expect(rows.notes).toEqual([]);
    // The failed refund does not count: all three units can still be refunded.
    gateway.refundFails = null;
    expect((await refund(o, 3)).ok).toBe(true);
  });

  it('keeps an unknown answer pending, blocks a second refund, and the worker settles it with the same key', async () => {
    const o = await paidOrder();
    gateway.refundFails = { code: 'payment.provider-unavailable' };

    const pending = await refund(o, 1);
    expect(pending.ok && pending.value.state).toBe('pending');
    expect(await refund(o, 1)).toEqual({
      ok: false,
      error: { code: 'ordering.refund-in-progress' },
    });

    gateway.refundFails = null;
    // Too young: the request's own call may still be running.
    expect(await new SettleRefunds(gate, deps).execute(system, {})).toEqual(
      ok({ succeeded: 0, failed: 0, stuck: [] }),
    );
    const later = { ...deps, clock: new FixedClock(T0.add({ minutes: 2 })) };
    const settled = await new SettleRefunds(gate, later).execute(system, {});
    expect(settled.ok && settled.value.succeeded).toBeGreaterThanOrEqual(1);
    const keys = gateway.refunds.map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect((await rowsOf(o.sellerOrderId)).notes).toHaveLength(1);
  });

  it('finds nothing when an admin names another order, and audits each request and outcome', async () => {
    const o = await paidOrder();
    expect(
      await new AdminRefundOrder(gate, deps).execute(admin, {
        orderId: ids.next<'Order'>(),
        sellerOrderId: o.sellerOrderId,
        lines: [{ orderLineId: o.lineId, quantity: 1 }],
        shippingAmount: undefined,
        reason: 'not-received',
      }),
    ).toEqual({ ok: false, error: { code: 'ordering.seller-order-not-found' } });

    const done = await refund(o, 1);
    if (!done.ok) throw new Error('refund');
    const rows = await sql.query<{ action: string; actor_type: string; after: unknown }>(
      `SELECT action, actor_type, after FROM platform.audit_log
        WHERE market_id = $1 AND target_type = 'ordering.refund' AND target_id = $2
        ORDER BY occurred_at, action`,
      [market.marketId, done.value.refundId],
    );
    expect(rows.rows.map((r) => [r.action, r.actor_type])).toEqual([
      ['ordering.refund.requested', 'USER'],
      ['ordering.refund.settled', 'USER'],
    ]);
    expect(rows.rows[0]!.after).toMatchObject({
      sellerOrderId: o.sellerOrderId,
      amount: { amount: done.value.amount.amount.toString(), currency },
      reason: 'damaged',
      lossBearer: 'seller',
      lineCount: 1,
    });
    expect(rows.rows[1]!.after).toEqual({
      outcome: 'succeeded',
      creditNoteId: done.value.creditNoteId,
    });
  });

  it('keeps a refund Stripe made but has not finished pending, then reads it back by id', async () => {
    const o = await paidOrder();
    gateway.refundAnswers = 'pending';

    const pending = await refund(o, 1);
    expect(pending.ok && pending.value.state).toBe('pending');
    const before = await rowsOf(o.sellerOrderId);
    expect(before.notes).toEqual([]);
    expect(before.refunds[0]?.stripe_refund_id).toMatch(/^re_test_/);

    // Still pending at Stripe: nothing changes; then it succeeds and the credit note is written.
    const later = { ...deps, clock: new FixedClock(T0.add({ minutes: 2 })) };
    gateway.readAnswers = 'pending';
    expect(await new SettleRefunds(gate, later).execute(system, {})).toEqual(
      ok({ succeeded: 0, failed: 0, stuck: [] }),
    );
    gateway.readAnswers = 'succeeded';
    const settled = await new SettleRefunds(gate, later).execute(system, {});
    expect(settled.ok && settled.value.succeeded).toBeGreaterThanOrEqual(1);
    // Read back by id, never asked for a second time.
    expect(gateway.refunds).toHaveLength(1);
    expect(gateway.statusReads).toContain(before.refunds[0]!.stripe_refund_id);
    const after = await rowsOf(o.sellerOrderId);
    expect(after.refunds.map((r) => r.state)).toEqual(['succeeded']);
    expect(after.notes).toHaveLength(1);
  });

  it('records a refund Stripe made that then failed as failed, keeping its Stripe id', async () => {
    const o = await paidOrder();
    gateway.refundAnswers = 'failed';

    expect(await refund(o, 2)).toEqual({ ok: false, error: { code: 'ordering.refund-rejected' } });

    const rows = await rowsOf(o.sellerOrderId);
    expect(rows.refunded).toBe('0');
    expect(rows.refunds.map((r) => [r.state, r.stripe_refund_id !== null])).toEqual([
      ['failed', true],
    ]);
    expect(rows.notes).toEqual([]);
  });

  it('writes nothing when the refunded sum moved since it was read (stale)', async () => {
    const o = await paidOrder();
    const repository = new PrismaRefundRepository(db.service);
    const first = await refund(o, 1);
    if (!first.ok) throw new Error('refund');
    const reserved = await db.unitOfWork.run(market, async () =>
      ok(
        await repository.reserve(
          market,
          {
            id: ids.next<'Refund'>(),
            orderId: o.orderId,
            sellerOrderId: o.sellerOrderId,
            sellerId: o.sellerId,
            currency,
            gross: 1n,
            tax: 0n,
            shipping: null,
            reason: 'other',
            lossBearer: 'seller',
            lossReasonCode: null,
            actor: { population: 'admin', accountId: ids.next<'Account'>() },
            state: 'pending',
            stripeIdempotencyKey: `refund-${ids.next()}`,
            stripeRefundId: null,
            attempts: 0,
            requestedAt: T0,
            settledAt: null,
            lines: [],
          },
          0n,
        ),
      ),
    );
    expect(reserved).toEqual(ok('stale'));
    expect((await rowsOf(o.sellerOrderId)).refunds).toHaveLength(1);
  });

  it('never lets the app role change a refund amount or a credit note', async () => {
    // `sql` connects as the application role.
    for (const statement of [
      'UPDATE ordering.refunds SET gross_amount = 1',
      'UPDATE ordering.refund_lines SET tax_amount = 0',
      'UPDATE ordering.credit_notes SET gross_amount = 1',
      'DELETE FROM ordering.credit_notes',
      'DELETE FROM ordering.refunds',
    ]) {
      await expect(sql.query(statement)).rejects.toThrow(/permission denied/);
    }
  });

  it('refuses re-opening a settled refund, lowering attempts or moving the refunded sum alone', async () => {
    const o = await paidOrder();
    const done = await refund(o, 1);
    if (!done.ok) throw new Error('refund');
    const scope = [market.marketId, done.value.refundId];
    for (const statement of [
      `UPDATE ordering.refunds SET state = 'pending', settled_at = NULL WHERE market_id = $1 AND id = $2`,
      `UPDATE ordering.refunds SET attempts = attempts + 1 WHERE market_id = $1 AND id = $2`,
    ]) {
      await expect(sql.query(statement, scope)).rejects.toThrow(/settled refund never changes/);
    }
    await expect(
      sql.query(
        'UPDATE ordering.seller_orders SET refunded_amount = 0 WHERE market_id = $1 AND id = $2',
        [market.marketId, o.sellerOrderId],
      ),
    ).rejects.toThrow(/refunded_amount differs from its refunds/);
    expect((await rowsOf(o.sellerOrderId)).refunded).toBe(done.value.amount.amount.toString());
  });

  it('refuses more units on a refund line than its order line has, and pending attempts going down', async () => {
    const o = await paidOrder();
    gateway.refundFails = { code: 'payment.provider-unavailable' };
    const pending = await refund(o, 1);
    if (!pending.ok) throw new Error('refund');
    const scope = [market.marketId, pending.value.refundId];
    await sql.query(
      'UPDATE ordering.refunds SET attempts = 3 WHERE market_id = $1 AND id = $2',
      scope,
    );
    await expect(
      sql.query('UPDATE ordering.refunds SET attempts = 2 WHERE market_id = $1 AND id = $2', scope),
    ).rejects.toThrow(/attempts only grow/);
    await expect(
      sql.query(
        `INSERT INTO ordering.refund_lines (market_id, tenant_id, refund_id, seller_order_id,
           order_line_id, quantity, line_quantity, units_before, gross_amount, tax_amount,
           tax_rate_bps, tax_inclusive)
         VALUES ($1, $2, $3, $4, $5, 2, 3, 2, 100, 0, 0, true)`,
        [market.marketId, market.tenantId, pending.value.refundId, o.sellerOrderId, ids.next()],
      ),
    ).rejects.toThrow(/refund_lines_quantity_check/);
  });

  it("writes every credit note with its own refund's amounts, currency and ids", async () => {
    const mismatched = await sql.query(
      `SELECT c.id FROM ordering.credit_notes c
         JOIN ordering.refunds r ON r.market_id = c.market_id AND r.id = c.refund_id
        WHERE c.market_id = $1 AND (r.state <> 'succeeded' OR c.gross_amount <> r.gross_amount
          OR c.tax_amount <> r.tax_amount OR c.currency <> r.currency
          OR c.order_id <> r.order_id OR c.seller_id <> r.seller_id)`,
      [market.marketId],
    );
    const notes = await sql.query('SELECT 1 FROM ordering.credit_notes WHERE market_id = $1', [
      market.marketId,
    ]);
    expect(notes.rowCount).toBeGreaterThan(0);
    expect(mismatched.rows).toEqual([]);
  });

  it('keeps a refund Stripe may have made pending when a later call is refused (rotated key)', async () => {
    const made = await paidOrder();
    gateway.refundAnswers = 'pending';
    const first = await refund(made, 1);
    if (!first.ok) throw new Error('refund');
    const unknown = await paidOrder();
    gateway.refundFails = { code: 'payment.provider-unavailable' };
    const second = await refund(unknown, 1);
    if (!second.ok) throw new Error('refund');

    // The worker's read-back and retry are refused: neither refund fails or frees its units.
    gateway.refundFails = { code: 'payment.provider-rejected' };
    const later = { ...deps, clock: new FixedClock(T0.add({ minutes: 2 })) };
    expect(await new SettleRefunds(gate, later).execute(system, {})).toEqual(
      ok({ succeeded: 0, failed: 0, stuck: [] }),
    );
    for (const o of [made, unknown]) {
      const rows = await rowsOf(o.sellerOrderId);
      expect(rows.refunds.map((r) => r.state)).toEqual(['pending']);
      expect(rows.refunded).toBe(rows.refunds[0]!.gross_amount);
    }
    gateway.refundFails = null;
    expect((await new SettleRefunds(gate, later).execute(system, {})).ok).toBe(true);
  });

  it('refuses a refund in an acting-as session', async () => {
    const o = await paidOrder();
    const actingAs = {
      ...admin,
      actor: { ...admin.actor, actingAs: { accountId: ids.next<'Account'>(), sellerId: null } },
    } as unknown as CallContext;

    // The flow itself, past the gate: the refusal is the acting-as check, not the context.
    const result = await adminRefund(deps, actingAs, {
      orderId: o.orderId,
      sellerOrderId: o.sellerOrderId,
      lines: [{ orderLineId: o.lineId, quantity: 1 }],
      shippingAmount: undefined,
      reason: 'damaged',
    });

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(gateway.refunds).toHaveLength(0);
  });

  it('refuses changing a kept Stripe id, or failing a refund without lowering the sum', async () => {
    const o = await paidOrder();
    gateway.refundAnswers = 'pending';
    const pending = await refund(o, 1);
    if (!pending.ok) throw new Error('refund');
    const scope = [market.marketId, pending.value.refundId];
    await expect(
      sql.query(
        `UPDATE ordering.refunds SET stripe_refund_id = 're_test_other' WHERE market_id = $1 AND id = $2`,
        scope,
      ),
    ).rejects.toThrow(/Stripe refund id never changes/);
    await expect(
      sql.query(
        `UPDATE ordering.refunds SET state = 'failed', settled_at = now() WHERE market_id = $1 AND id = $2`,
        scope,
      ),
    ).rejects.toThrow(/refunded_amount differs from its refunds/);
  });
  describe('who bears the loss', () => {
    it('stores the seller by default, and the platform with its reason code, both audited', async () => {
      const o = await paidOrder();
      const bySeller = await refund(o, 1);
      // The refunds of one seller order are made one after the other, so their instants differ.
      const later = { ...deps, clock: new FixedClock(T0.add({ seconds: 5 })) };
      const byPlatform = await refund(o, 1, undefined, later, {
        lossBearer: 'platform',
        lossReasonCode: 'carrier-loss',
      });
      if (!bySeller.ok || !byPlatform.ok) throw new Error('refund');
      expect(bySeller.value).toMatchObject({ lossBearer: 'seller', lossReasonCode: null });
      expect(byPlatform.value).toMatchObject({
        lossBearer: 'platform',
        lossReasonCode: 'carrier-loss',
      });
      const stored = await sql.query<{
        id: string;
        loss_bearer: string;
        loss_reason_code: string | null;
      }>(
        `SELECT id, loss_bearer, loss_reason_code FROM ordering.refunds
          WHERE market_id = $1 AND seller_order_id = $2 ORDER BY requested_at, id`,
        [market.marketId, o.sellerOrderId],
      );
      expect(stored.rows.map((r) => [r.loss_bearer, r.loss_reason_code])).toEqual([
        ['seller', null],
        ['platform', 'carrier-loss'],
      ]);
      const audited = await sql.query<{ after: unknown }>(
        `SELECT after FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2 AND action = 'ordering.refund.requested'`,
        [market.marketId, byPlatform.value.refundId],
      );
      expect(audited.rows[0]!.after).toMatchObject({
        lossBearer: 'platform',
        lossReasonCode: 'carrier-loss',
      });
    });

    it('refuses a platform refund without a reason code, and a code for a seller refund', async () => {
      const o = await paidOrder();
      expect(await refund(o, 1, undefined, deps, { lossBearer: 'platform' })).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: 'lossReasonCode', code: 'required' }],
        },
      });
      expect(await refund(o, 1, undefined, deps, { lossReasonCode: 'goodwill' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'lossReasonCode', code: 'unexpected' }] },
      });
      expect(await refund(o, 1, undefined, deps, { lossBearer: 'customer' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'lossBearer', code: 'value' }] },
      });
      expect((await rowsOf(o.sellerOrderId)).refunds).toEqual([]);
    });

    it('is closed in the database: a bearer from the list, a code exactly for the platform', async () => {
      const o = await paidOrder();
      const done = await refund(o, 1);
      if (!done.ok) throw new Error('refund');
      const insert = (bearer: string, reason: string | null) =>
        sql.query(
          `INSERT INTO ordering.refunds (id, market_id, tenant_id, order_id, seller_order_id, seller_id,
             currency, gross_amount, tax_amount, shipping_gross_amount, shipping_tax_amount, reason,
             actor_population, actor_account_id, state, stripe_idempotency_key, requested_at,
             loss_bearer, loss_reason_code)
           SELECT $1, market_id, tenant_id, order_id, seller_order_id, seller_id, currency, 1, 0, 0, 0,
                  'other', 'admin', actor_account_id, 'pending', $2, now(), $3, $4
             FROM ordering.refunds WHERE market_id = $5 AND id = $6`,
          [ids.next(), `k-${ids.next()}`, bearer, reason, market.marketId, done.value.refundId],
        );
      await expect(insert('customer', null)).rejects.toThrow(/refunds_loss_bearer_check/);
      await expect(insert('platform', null)).rejects.toThrow(/refunds_loss_pair_check/);
      await expect(insert('seller', 'goodwill')).rejects.toThrow(/refunds_loss_pair_check/);
      await expect(insert('platform', 'because')).rejects.toThrow(/refunds_loss_reason_code_check/);
    });
  });

  describe('the seller ledger step', () => {
    /** Writes the paid seller orders into the ledger, 20 at a time, until none is left. */
    const recordPaid = async () => {
      for (let run = 0; run < 50; run += 1) {
        const result = await new RecordLedger(gate, deps).execute(system, {});
        if (!result.ok) throw new Error('ledger step refused');
        if (result.value.recorded === 0 && result.value.failed.length === 0) return;
      }
    };
    const step = () => new RecordRefundLedger(gate, deps).execute(system, {});
    /** Runs the step until it has nothing of this file's left to do (earlier tests leave refunds). */
    const drain = async () => {
      for (let run = 0; run < 20; run += 1) {
        const result = await step();
        if (!result.ok) throw new Error('step refused');
        if (result.value.recorded === 0 && result.value.failed.length === 0) return;
      }
    };
    const marker = async (refundId: string) =>
      (
        await sql.query<{ ledger_recorded_at: Date | null; ledger_attempts: number }>(
          'SELECT ledger_recorded_at, ledger_attempts FROM ordering.refunds WHERE market_id = $1 AND id = $2',
          [market.marketId, refundId],
        )
      ).rows[0]!;

    it('waits for the seller order paid facts, then sends the refund ids and numbers once', async () => {
      const o = await paidOrder();
      const done = await refund(o, 2, (shipping / 2n).toString());
      if (!done.ok) throw new Error('refund');

      await drain();
      expect(commission.refundsRecorded.map((r) => r.refundId)).not.toContain(done.value.refundId);
      expect((await marker(done.value.refundId)).ledger_recorded_at).toBeNull();

      await recordPaid();
      await drain();
      const sent = commission.refundsRecorded.find((r) => r.refundId === done.value.refundId);
      const shippingGross = inclusive ? shipping : shipping + shippingTax;
      expect(sent).toMatchObject({
        orderId: o.orderId,
        sellerOrderId: o.sellerOrderId,
        sellerId: o.sellerId,
        currency,
        lossBearer: 'seller',
        lines: [{ orderLineId: o.lineId, lineQuantity: 3, unitsBefore: 0, units: 2 }],
        shipping: { refundedBefore: 0n, refundedAfter: shipping / 2n, charge: shippingGross },
      });
      expect(sent?.settledAt.epochMilliseconds).toBe(T0.epochMilliseconds);
      expect((await marker(done.value.refundId)).ledger_recorded_at).not.toBeNull();
      // Marked once: another run sends nothing again.
      const count = commission.refundsRecorded.length;
      await drain();
      expect(commission.refundsRecorded).toHaveLength(count);
    });

    it('sends the cumulative units and shipping of a second partial refund', async () => {
      const o = await paidOrder();
      await recordPaid();
      const half = shipping / 2n;
      const first = await refund(o, 1, half.toString());
      const later = { ...deps, clock: new FixedClock(T0.add({ seconds: 5 })) };
      const second = await refund(o, 1, half.toString(), later);
      if (!first.ok || !second.ok) throw new Error('refund');
      await drain();
      const second_ = commission.refundsRecorded.find((r) => r.refundId === second.value.refundId);
      expect(second_?.lines).toEqual([
        { orderLineId: o.lineId, lineQuantity: 3, unitsBefore: 1, units: 1 },
      ]);
      expect(second_?.shipping).toMatchObject({ refundedBefore: half, refundedAfter: half * 2n });
    });

    it('marks a platform-borne refund handled too, with the bearer for commission-payouts to see', async () => {
      const o = await paidOrder();
      await recordPaid();
      const done = await refund(o, 1, undefined, deps, {
        lossBearer: 'platform',
        lossReasonCode: 'goodwill',
      });
      if (!done.ok) throw new Error('refund');
      await drain();
      expect(
        commission.refundsRecorded.find((r) => r.refundId === done.value.refundId)?.lossBearer,
      ).toBe('platform');
      expect((await marker(done.value.refundId)).ledger_recorded_at).not.toBeNull();
    });

    it('counts each refusal, reports a stuck refund once at five, and still records the rest', async () => {
      const o = await paidOrder();
      await recordPaid();
      const stuck = await refund(o, 1);
      const other = await paidOrder();
      await recordPaid();
      const fine = await refund(other, 1);
      if (!stuck.ok || !fine.ok) throw new Error('refund');
      commission.refundFails = { code: 'commission-payouts.ledger-inconsistent' };
      commission.refundFailOnly = stuck.value.refundId;

      const reported: unknown[] = [];
      for (let run = 0; run < 6; run += 1) {
        const result = await step();
        if (!result.ok) throw new Error('step refused');
        reported.push(...result.value.stuck.filter((s) => s.refundId === stuck.value.refundId));
      }
      expect(reported).toEqual([
        {
          refundId: stuck.value.refundId,
          attempts: 5,
          code: 'commission-payouts.ledger-inconsistent',
        },
      ]);
      expect(await marker(stuck.value.refundId)).toMatchObject({
        ledger_recorded_at: null,
        ledger_attempts: 6,
      });
      expect((await marker(fine.value.refundId)).ledger_recorded_at).not.toBeNull();

      // Once the ledger accepts it, it is recorded.
      commission.refundFails = null;
      await drain();
      expect((await marker(stuck.value.refundId)).ledger_recorded_at).not.toBeNull();
    });

    it('marks a refund of a seller order that never reached the ledger, without sending it', async () => {
      const o = await paidOrder();
      const done = await refund(o, 1);
      if (!done.ok) throw new Error('refund');
      await sql.query(
        `UPDATE ordering.seller_orders SET ledger_state = 'not-applicable' WHERE market_id = $1 AND id = $2`,
        [market.marketId, o.sellerOrderId],
      );
      await drain();
      expect(commission.refundsRecorded.map((r) => r.refundId)).not.toContain(done.value.refundId);
      expect((await marker(done.value.refundId)).ledger_recorded_at).not.toBeNull();
    });

    it('lets a settled refund take its ledger marker once, never clear it, and never a pending one', async () => {
      const o = await paidOrder();
      await recordPaid();
      const done = await refund(o, 1);
      if (!done.ok) throw new Error('refund');
      const scope = [market.marketId, done.value.refundId];
      await expect(
        sql.query(
          'UPDATE ordering.refunds SET ledger_attempts = ledger_attempts + 1 WHERE market_id = $1 AND id = $2',
          scope,
        ),
      ).resolves.toBeDefined();
      await sql.query(
        'UPDATE ordering.refunds SET ledger_recorded_at = now() WHERE market_id = $1 AND id = $2',
        scope,
      );
      await expect(
        sql.query(
          'UPDATE ordering.refunds SET ledger_recorded_at = NULL WHERE market_id = $1 AND id = $2',
          scope,
        ),
      ).rejects.toThrow(/ledger marker never changes/);
      await expect(
        sql.query(
          'UPDATE ordering.refunds SET ledger_attempts = 0 WHERE market_id = $1 AND id = $2',
          scope,
        ),
      ).rejects.toThrow(/ledger attempts only grow/);
      await expect(
        sql.query(
          'UPDATE ordering.refunds SET gross_amount = gross_amount WHERE market_id = $1 AND id = $2',
          scope,
        ),
      ).rejects.toThrow(/permission denied/);

      gateway.refundFails = { code: 'payment.provider-unavailable' };
      const pending = await refund(o, 1);
      if (!pending.ok) throw new Error('refund');
      await expect(
        sql.query(
          'UPDATE ordering.refunds SET ledger_recorded_at = now() WHERE market_id = $1 AND id = $2',
          [market.marketId, pending.value.refundId],
        ),
      ).rejects.toThrow(/refunds_ledger_check|only a settled refund reaches the ledger/);
    });
  });
  describe('with the real seller ledger', () => {
    let real: OrderingDependencies;
    let ledger: PrismaLedgerRepository;

    beforeEach(() => {
      ledger = new PrismaLedgerRepository(db.service);
      const ledgerDeps: CommissionPayoutsDependencies = {
        unitOfWork: db.unitOfWork,
        rates: new PrismaSellerRateRepository(db.service),
        ledger,
        policy: new ConfigCommissionPolicy(markets),
        sellers: { exists: () => Promise.resolve(true) },
        audit,
        ids,
        clock,
      };
      real = {
        ...deps,
        commission: {
          commissionRates: () => Promise.reject(new Error('not used')),
          recordSellerOrderPaid: (context, paid) =>
            new RecordSellerOrderPaid(gate, ledgerDeps).execute(context, paid),
          recordRefund: (context, facts) =>
            new RecordRefund(gate, ledgerDeps).execute(context, facts),
        },
      };
    });

    const settle = async () => {
      for (let run = 0; run < 50; run += 1) {
        const paid = await new RecordLedger(gate, real).execute(system, {});
        const done = await new RecordRefundLedger(gate, real).execute(system, {});
        if (!paid.ok || !done.ok) throw new Error('step refused');
        expect(done.value.failed).toEqual([]);
        if (paid.value.recorded === 0 && done.value.recorded === 0) return;
      }
    };
    const kinds = async (o: { sellerOrderId: string; sellerId: Id<'Seller'> }) => {
      const rows = await value(() => ledger.list(market, o.sellerId, { limit: 100, after: null }));
      const by = (kind: LedgerKind) =>
        rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.amount.amount, 0n);
      return { rows, by };
    };
    const value = <T>(work: () => Promise<T>) =>
      db.unitOfWork
        .run(market, async () => ok(await work()))
        .then((r) => {
          if (!r.ok) throw new Error('unit failed');
          return r.value;
        });
    const later = (seconds: number) => ({ ...real, clock: new FixedClock(T0.add({ seconds })) });
    const charge = inclusive ? shipping : shipping + shippingTax;

    it('reverses the sale, the commission and the delivery fee exactly over three partial refunds', async () => {
      const o = await paidOrder();
      const half = charge / 2n;
      const a = await refund(o, 1, half.toString(), later(0));
      const b = await refund(o, 1, undefined, later(5));
      const c = await refund(o, 1, (charge - half).toString(), later(10));
      if (!a.ok || !b.ok || !c.ok) throw new Error('refund');
      await settle();

      const { rows, by } = await kinds(o);
      expect(by('sale')).toBe(3300n);
      expect(by('refund-sale')).toBe(by('sale'));
      expect(by('refund-commission')).toBe(by('commission'));
      expect(by('refund-shipping')).toBe(by('shipping'));
      expect(by('shipping')).toBe(shipping);
      // Three refunds, each with its own sale and commission row; two with a shipping row.
      expect(rows.filter((r) => r.kind === 'refund-sale')).toHaveLength(3);
      expect(rows.filter((r) => r.kind === 'refund-commission')).toHaveLength(3);
      expect(rows.filter((r) => r.kind === 'refund-shipping')).toHaveLength(2);
      expect(
        rows.filter((r) => r.kind === 'refund-commission').every((r) => r.rateBps === 1500),
      ).toBe(true);
      const sums = await value(() => ledger.sums(market, o.sellerId));
      expect(totalsOf(Object.fromEntries(sums.map((x) => [x.kind, x.amount]))).balance).toBe(0n);
    });

    it('leaves the seller its whole share when the platform bears the loss', async () => {
      const o = await paidOrder();
      const platform = await refund(o, 1, undefined, later(0), {
        lossBearer: 'platform',
        lossReasonCode: 'platform-error',
      });
      const seller = await refund(o, 1, undefined, later(5));
      if (!platform.ok || !seller.ok) throw new Error('refund');
      await settle();

      const { rows, by } = await kinds(o);
      // Only the second unit is the seller's loss: the share of unit 2 on the cumulative scale.
      expect(rows.filter((r) => r.kind === 'refund-sale')).toHaveLength(1);
      expect(rows.find((r) => r.kind === 'refund-sale')?.sourceId).toBe(seller.value.refundId);
      expect(by('refund-sale')).toBe(1100n);
      // The platform refund is still marked handled.
      const marks = await sql.query<{ ledger_recorded_at: Date | null }>(
        'SELECT ledger_recorded_at FROM ordering.refunds WHERE market_id = $1 AND id = $2',
        [market.marketId, platform.value.refundId],
      );
      expect(marks.rows[0]!.ledger_recorded_at).not.toBeNull();
    });

    it('records nothing twice when the step runs again, and lets a balance go negative', async () => {
      const o = await paidOrder();
      const whole = await refund(o, 3, charge.toString());
      if (!whole.ok) throw new Error('refund');
      await settle();
      const before = (await kinds(o)).rows.length;
      await settle();
      expect((await kinds(o)).rows).toHaveLength(before);
      // A debit with nothing against it (here a
      // dispute debit added by hand) takes the balance below zero.
      await sql.query(
        `INSERT INTO commission_payouts.ledger_entries (id, market_id, tenant_id, seller_id, order_id,
           seller_order_id, kind, amount, currency, source_id, occurred_at, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'dispute-debit', 100, $7, $8, now(), now())`,
        [
          ids.next(),
          market.marketId,
          market.tenantId,
          o.sellerId,
          o.orderId,
          o.sellerOrderId,
          currency,
          ids.next(),
        ],
      );
      const sums = await value(() => ledger.sums(market, o.sellerId));
      expect(totalsOf(Object.fromEntries(sums.map((x) => [x.kind, x.amount]))).balance).toBe(-100n);
    });
  });
});

describe('the closed lists of refunds (database catalog)', () => {
  it('equal the CHECKs of ordering.refunds, value for value', async () => {
    const sql = new Client({ connectionString: orderingRefundsTestDatabaseUrl() });
    await sql.connect();
    try {
      const rows = await sql.query<{ conname: string; def: string }>(
        `SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'ordering' AND t.relname = 'refunds'
            AND c.conname IN ('refunds_loss_bearer_check', 'refunds_loss_reason_code_check')`,
      );
      const listOf = (name: string) =>
        [...(rows.rows.find((r) => r.conname === name)?.def ?? '').matchAll(/'([a-z-]+)'::text/g)]
          .map((m) => m[1])
          .sort();
      expect(listOf('refunds_loss_bearer_check')).toEqual([...LOSS_BEARERS].sort());
      expect(listOf('refunds_loss_reason_code_check')).toEqual([...LOSS_REASON_CODES].sort());
    } finally {
      await sql.end();
    }
  });
});
