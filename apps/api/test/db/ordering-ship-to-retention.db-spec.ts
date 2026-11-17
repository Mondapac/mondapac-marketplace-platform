import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type {
  ShipToPurgeBatch,
  ShipToPurgeCursor,
} from '../../src/modules/ordering/application/ports/ship-to-retention.repository';
import type { ShipToRetentionDependencies } from '../../src/modules/ordering/application/ship-to-retention-flow';
import { AdminSetShipToRetention } from '../../src/modules/ordering/application/use-cases/admin-set-ship-to-retention.use-case';
import { AdminViewShipToRetention } from '../../src/modules/ordering/application/use-cases/admin-view-ship-to-retention.use-case';
import { PurgeSettledShipTo } from '../../src/modules/ordering/application/use-cases/purge-settled-ship-to.use-case';
import { ORDERING_AUDIT_ACTIONS } from '../../src/modules/ordering/domain/audit';
import { isShipToPurgeable } from '../../src/modules/ordering/domain/ship-to-retention';
import {
  LINE_QUANTITY,
  refundRequestedAt,
  refundSettledAt,
  settlementCases,
  settlementFacts,
  type OrderSpec,
} from '../support/ship-to-settlement-fixtures';
import type { OrderState, SellerOrder } from '../../src/modules/ordering/domain/order';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import {
  PrismaShipToRetentionRepository,
  RegistryMarketZones,
} from '../../src/modules/ordering/infrastructure/prisma-ship-to-retention.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { FakeStepUp } from '../support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The ship-to retention setting and its daily purge on PostgreSQL as the application role, in
// both Market fixtures (owner decision 2026-11-15): the real use cases on the real unit of work and
// audit writer set the Market's row and clear the sealed ship-to of orders whose seller orders were
// all settled (delivered, shipped never delivered, cancelled, refunded in full while to ship), the
// latest at least `months` months ago in the Market's zone; an order with an unsettled seller order
// keeps it; a second run clears nothing; no Market reaches another's orders; the CHECKs
// hold; the role may update the ship-to column and the setting's own columns only.

const CHECK = '23514';
const DENIED = '42501';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('ship-to retention in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const zone = markets.get(market.marketId).timezone;
  const local = (text: string) =>
    Temporal.PlainDateTime.from(text).toZonedDateTime(zone).toInstant();
  const NOW = local('2026-11-15T03:00:00');
  const clock = new FixedClock(NOW);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const currency = (target: MarketContext) => (target.marketId === 'AU' ? 'AUD' : 'JPY');
  const admin = (target: MarketContext = market) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'ship-to-db-admin-abcd',
    );
  const system = (target: MarketContext = market) =>
    testCallContext(target, 'system', 'ship-to-db-system-abc');
  let db: Persistence;
  let orders: PrismaOrderRepository;
  let deps: ShipToRetentionDependencies;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    orders = new PrismaOrderRepository(db.service);
    const catalogue = new AuditActionCatalogue();
    catalogue.register('ordering', ORDERING_AUDIT_ACTIONS);
    catalogue.seal();
    const audit = PersistenceModule.auditWriterFor('ordering').useFactory(
      catalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    deps = {
      unitOfWork: db.unitOfWork,
      retention: new PrismaShipToRetentionRepository(db.service),
      zones: new RegistryMarketZones(markets),
      audit,
      stepUp: new FakeStepUp(),
      clock,
      ids,
    };
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await Promise.all([sql.connect(), owner.connect()]);
  });
  beforeEach(async () => {
    await owner.query(`DELETE FROM ordering.ship_to_retention_settings WHERE market_id = ANY($1)`, [
      [market.marketId, other.marketId],
    ]);
  });
  afterAll(async () => {
    await db.close();
    await Promise.all([sql.end(), owner.end()]);
  });

  const setting = async (input: object, target: MarketContext = market) => {
    const view = await new AdminViewShipToRetention(gate, deps).execute(admin(target), {});
    if (!view.ok) throw new Error('view refused');
    const result = await new AdminSetShipToRetention(gate, deps).execute(admin(target), {
      enabled: true,
      months: 24,
      expectedVersion: view.value.version,
      ...input,
    });
    if (!result.ok) throw new Error(`set refused: ${result.error.code}`);
    return result.value;
  };
  const purge = async (target: MarketContext = market) => {
    const result = await new PurgeSettledShipTo(gate, deps).execute(system(target), {});
    if (!result.ok) throw new Error('purge refused');
    return result.value;
  };

  /** A seller order as placed (to ship); `placed` then records its delivery as the seller would. */
  const sellerOrder = (): SellerOrder => ({
    id: ids.next<'SellerOrder'>(),
    sellerId: ids.next<'Seller'>(),
    subtotal: 1000n,
    shipping: 0n,
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
    ledgerState: 'pending',
    deliveryMethod: 'instant',
    deliveryWindow: null,
    readyAt: null,
    readyPrepMinutes: null,
    deliveryAttention: null,
    deliveryQuote: null,
  });
  /**
   * An order of `target` built from a spec of the shared fixtures: placed confirmed, then moved as
   * the flows would leave it (shipped, delivered, refunded with the seller order's refunded sum
   * raised in the same transaction, or cancelled). Each seller order has one line of
   * LINE_QUANTITY units of 500 minor units each.
   */
  const placedSpec = async (
    spec: OrderSpec,
    target: MarketContext = market,
  ): Promise<Id<'Order'>> => {
    const orderId = ids.next<'Order'>();
    const sellerOrders = spec.sellerOrders.map(() => sellerOrder());
    const state: OrderState = {
      id: orderId,
      marketId: target.marketId,
      accountId: ids.next<'Account'>(),
      status: 'confirmed',
      cancelReason: null,
      paymentState: 'captured',
      total: money(1000n * BigInt(sellerOrders.length), currency(target)),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: null,
      stripePaymentIntentId: `pi_test_${orderId}`,
      paymentExpiresAt: local('2022-01-01T00:30:00'),
      createdAt: local('2022-01-01T00:00:00'),
      confirmedAt: local('2022-01-01T00:05:00'),
      cancelledAt: null,
      version: 1,
      taxStrategyId: null,
      shipToSealed: `v1.ship-to-of-${orderId}`,
      sellerOrders,
      lines: sellerOrders.map((so) => ({
        id: ids.next<'OrderLine'>(),
        sellerOrderId: so.id,
        offerId: ids.next<'Offer'>(),
        variantId: ids.next<'Variant'>(),
        quantity: LINE_QUANTITY,
        unitPrice: money(500n, currency(target)),
        lineAmount: 1000n,
        taxInclusive: true,
        reservationLineId: ids.next<'ReservationLine'>(),
        commissionRateBps: 1500,
        commissionRateReason: 'standard',
        exclusiveSeller: false,
        taxRateBps: 1000,
        taxAmount: 91n,
        taxCategoryCode: 'taxable',
      })),
    };
    const done = await db.unitOfWork.run(target, async () => {
      await orders.insert(target, state);
      return ok(undefined);
    });
    if (!done.ok) throw new Error('insert failed');
    for (const [index, so] of spec.sellerOrders.entries()) {
      const sellerOrderId = state.sellerOrders[index]!.id;
      if (so.kind === 'delivered' || so.kind === 'shipped') {
        await owner.query(
          `UPDATE ordering.seller_orders
              SET fulfilment = $2, carrier = 'Test courier', shipped_at = $3, delivered_at = $4
            WHERE id = $1`,
          [
            sellerOrderId,
            so.kind,
            (so.kind === 'delivered' ? so.at.subtract({ hours: 2 }) : so.at).toString(),
            so.kind === 'delivered' ? so.at.toString() : null,
          ],
        );
        continue;
      }
      let unitsBefore = 0;
      for (const refund of so.refunds ?? []) {
        const refundState = refund.state ?? 'succeeded';
        const gross = 500 * refund.units;
        const refundId = ids.next<'Refund'>();
        await owner.query('BEGIN');
        try {
          if (refundState !== 'failed') {
            await owner.query(
              // refunded_in_full follows the refunded gross (CHECK), as the refund unit keeps it.
              `UPDATE ordering.seller_orders
                  SET refunded_amount = refunded_amount + $2,
                      refunded_in_full = (total_amount > 0 AND refunded_amount + $2 = total_amount)
                WHERE id = $1`,
              [sellerOrderId, gross],
            );
          }
          await owner.query(
            `INSERT INTO ordering.refunds (id, market_id, tenant_id, order_id, seller_order_id,
               seller_id, currency, gross_amount, tax_amount, shipping_gross_amount,
               shipping_tax_amount, reason, actor_population, actor_account_id, state,
               stripe_idempotency_key, stripe_refund_id, requested_at, settled_at)
             SELECT $1, market_id, tenant_id, order_id, id, seller_id, $3, $4, 0, 0, 0, 'other',
                    'admin', $5, $6, $7, $8, $9, $10
               FROM ordering.seller_orders WHERE id = $2`,
            [
              refundId,
              sellerOrderId,
              currency(target),
              gross,
              ids.next(),
              refundState,
              `refund-${refundId}`,
              refundState === 'succeeded' ? `re_test_${refundId.replaceAll('-', '')}` : null,
              refundRequestedAt(refund).toString(),
              refundSettledAt(refund)?.toString() ?? null,
            ],
          );
          await owner.query(
            `INSERT INTO ordering.refund_lines (market_id, tenant_id, refund_id, seller_order_id,
               order_line_id, quantity, line_quantity, units_before, gross_amount, tax_amount,
               tax_rate_bps, tax_inclusive)
             VALUES ($1, 'default', $2, $3, $4, $5, $6, $7, $8, 0, 0, true)`,
            [
              target.marketId,
              refundId,
              sellerOrderId,
              state.lines[index]!.id,
              refund.units,
              LINE_QUANTITY,
              unitsBefore,
              gross,
            ],
          );
          await owner.query('COMMIT');
        } catch (error) {
          await owner.query('ROLLBACK');
          throw error;
        }
        if (refundState !== 'failed') unitsBefore += refund.units;
      }
    }
    if ((spec.status ?? 'confirmed') === 'cancelled') {
      await owner.query(
        `UPDATE ordering.orders SET status = 'cancelled', cancel_reason = 'expired',
            payment_state = 'voided', confirmed_at = NULL, cancelled_at = $2
          WHERE id = $1`,
        [orderId, spec.cancelledAt!.toString()],
      );
    }
    return orderId;
  };
  /** A confirmed order with one seller order per delivery instant (null: still to ship). */
  const placed = (deliveries: (string | null)[], target: MarketContext = market) =>
    placedSpec(
      {
        sellerOrders: deliveries.map((at) =>
          at === null
            ? { kind: 'to-ship' as const }
            : { kind: 'delivered' as const, at: local(at) },
        ),
      },
      target,
    );
  const shipToOf = async (orderId: string) =>
    (
      await owner.query<{ ship_to_ciphertext: string | null }>(
        'SELECT ship_to_ciphertext FROM ordering.orders WHERE id = $1',
        [orderId],
      )
    ).rows[0]!.ship_to_ciphertext;
  const purgeAudits = async (target: MarketContext = market) =>
    (
      await owner.query<{ after: { cleared: number; months: number } }>(
        `SELECT after FROM platform.audit_log
          WHERE market_id = $1 AND action = 'ordering.ship-to.purged' ORDER BY occurred_at, id`,
        [target.marketId],
      )
    ).rows.map((row) => row.after);

  /**
   * Clears what earlier tests of this file left eligible (switching the setting on with 24 months),
   * so a following run counts only its own fixtures: other specs place orders delivered in 2026,
   * never before the 24-month cutoff, and this file is the only one that writes the setting.
   */
  const drain = async (months = 24) => {
    await setting({ enabled: true, months });
    await purge();
  };

  it('does nothing while never set or off', async () => {
    const old = await placed(['2020-01-01T00:00:00']);
    expect(await purge()).toEqual({ outcome: 'disabled', cleared: 0 });
    await setting({ enabled: false });
    expect(await purge()).toEqual({ outcome: 'disabled', cleared: 0 });
    expect(await shipToOf(old)).toBe(`v1.ship-to-of-${old}`);
  });

  it("clears orders all delivered 24 months ago in the Market's zone, and nothing else", async () => {
    await drain();
    const due = await placed(['2024-11-15T03:00:00']);
    const early = await placed(['2024-11-16T03:00:00']);
    const undelivered = await placed(['2021-06-01T00:00:00', null]);
    const twoOld = await placed(['2021-06-01T00:00:00', '2023-01-01T00:00:00']);
    const foreign = await placed(['2020-01-01T00:00:00'], other);
    const before = (await purgeAudits()).length;

    expect(await purge()).toEqual({ outcome: 'complete', cleared: 2 });

    expect(await shipToOf(due)).toBeNull();
    expect(await shipToOf(twoOld)).toBeNull();
    expect(await shipToOf(early)).toBe(`v1.ship-to-of-${early}`);
    expect(await shipToOf(undelivered)).toBe(`v1.ship-to-of-${undelivered}`);
    expect(await shipToOf(foreign)).toBe(`v1.ship-to-of-${foreign}`);
    // Idempotent: the second run finds nothing more, and says so in its own audit row.
    expect(await purge()).toEqual({ outcome: 'complete', cleared: 0 });
    const audits = (await purgeAudits()).slice(before);
    expect(audits.map((a) => [a.months, a.cleared])).toEqual([
      [24, 2],
      [24, 0],
    ]);
    expect(JSON.stringify(audits)).not.toContain(due);
  });

  it('counts only the due order, not one already cleared beside it', async () => {
    await drain();
    const due = await placed(['2023-05-01T00:00:00']);
    const cleared = await placed(['2023-05-01T00:00:00']);
    await owner.query('UPDATE ordering.orders SET ship_to_ciphertext = NULL WHERE id = $1', [
      cleared,
    ]);

    expect(await purge()).toEqual({ outcome: 'complete', cleared: 1 });
    expect(await shipToOf(due)).toBeNull();
    expect(await shipToOf(cleared)).toBeNull();
  });

  it('clears exactly the orders isShipToPurgeable allows, on the shared fixtures (no drift)', async () => {
    await drain();
    const cutoff = local('2024-11-15T03:00:00');
    const cases = settlementCases(cutoff);
    const placedCases = [];
    for (const c of cases) placedCases.push({ ...c, id: await placedSpec(c.spec) });
    // The rule in code on the same specs: the shared answers, and what the database must do.
    for (const [index, c] of cases.entries()) {
      expect([c.name, isShipToPurgeable(settlementFacts(c.spec, index), cutoff)]).toEqual([
        c.name,
        c.purgeable,
      ]);
    }

    let cleared = 0;
    let after: ShipToPurgeCursor | null = null;
    for (let n = 0; n < 100; n += 1) {
      const from: ShipToPurgeCursor | null = after;
      const batch: Result<ShipToPurgeBatch, never> = await db.unitOfWork.run(market, async () =>
        ok(await deps.retention.clearSettledShipTo(market, cutoff, from, 500)),
      );
      if (!batch.ok) throw new Error('batch failed');
      cleared += batch.value.cleared;
      after = batch.value.next;
      if (after === null) break;
    }

    const actual = [];
    for (const c of placedCases) actual.push([c.name, (await shipToOf(c.id)) === null]);
    expect(actual).toEqual(cases.map((c) => [c.name, c.purgeable]));
    expect(cleared).toBe(cases.filter((c) => c.purgeable).length);
  });

  it('runs the job over cancelled, shipped-never-delivered and refunded orders, old and new', async () => {
    await drain();
    const old = local('2023-01-10T00:00:00');
    const recent = local('2026-01-10T00:00:00');
    const cancelledOld = await placedSpec({
      status: 'cancelled',
      cancelledAt: old,
      sellerOrders: [{ kind: 'to-ship' }],
    });
    const cancelledNew = await placedSpec({
      status: 'cancelled',
      cancelledAt: recent,
      sellerOrders: [{ kind: 'to-ship' }],
    });
    const shippedOld = await placedSpec({ sellerOrders: [{ kind: 'shipped', at: old }] });
    const shippedNew = await placedSpec({ sellerOrders: [{ kind: 'shipped', at: recent }] });
    const refundedOld = await placedSpec({
      sellerOrders: [{ kind: 'to-ship', refunds: [{ at: old, units: 2 }] }],
    });
    const refundedNew = await placedSpec({
      sellerOrders: [{ kind: 'to-ship', refunds: [{ at: recent, units: 2 }] }],
    });
    const mixed = await placedSpec({
      sellerOrders: [{ kind: 'delivered', at: old }, { kind: 'to-ship' }],
    });

    expect(await purge()).toEqual({ outcome: 'complete', cleared: 3 });
    for (const orderId of [cancelledOld, shippedOld, refundedOld]) {
      expect(await shipToOf(orderId)).toBeNull();
    }
    for (const orderId of [cancelledNew, shippedNew, refundedNew, mixed]) {
      expect(await shipToOf(orderId)).toBe(`v1.ship-to-of-${orderId}`);
    }
    expect(await purge()).toEqual({ outcome: 'complete', cleared: 0 });
  });

  it('lets the sealed ship-to only be cleared, for every role (trigger)', async () => {
    const orderId = await placed([null]);
    for (const client of [sql, owner]) {
      await expect(
        client.query(
          `UPDATE ordering.orders SET ship_to_ciphertext = 'v1.another-sealed-address-of-the-customer' WHERE id = $1`,
          [orderId],
        ),
      ).rejects.toMatchObject({
        code: CHECK,
        message: 'ordering.orders: the sealed ship-to may only be cleared',
      });
    }
    expect(await shipToOf(orderId)).toBe(`v1.ship-to-of-${orderId}`);
    await expect(
      sql.query('UPDATE ordering.orders SET ship_to_ciphertext = NULL WHERE id = $1', [orderId]),
    ).resolves.toBeDefined();
    expect(await shipToOf(orderId)).toBeNull();
    // Other columns of the order still change as before (the trigger fires on this column only).
    await expect(
      sql.query('UPDATE ordering.orders SET version = version + 1 WHERE id = $1', [orderId]),
    ).resolves.toBeDefined();
  });

  it('pages by (confirmed_at, id) with a cursor, ties included, until a short batch', async () => {
    await drain();
    const three = [
      await placed(['2023-03-01T00:00:00']),
      await placed(['2023-03-01T00:00:00']),
      await placed(['2023-03-01T00:00:00']),
    ];
    const cutoff = local('2024-11-15T03:00:00');
    const sizes: number[] = [];
    let after: ShipToPurgeCursor | null = null;
    for (let n = 0; n < 1000; n += 1) {
      const from: ShipToPurgeCursor | null = after;
      const batch: Result<ShipToPurgeBatch, never> = await db.unitOfWork.run(market, async () =>
        ok(await deps.retention.clearSettledShipTo(market, cutoff, from, 2)),
      );
      if (!batch.ok) throw new Error('batch failed');
      sizes.push(batch.value.cleared);
      after = batch.value.next;
      if (after === null) break;
    }
    expect(sizes.every((size) => size <= 2)).toBe(true);
    expect(sizes.at(-1)).toBeLessThan(2);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(3);
    for (const orderId of three) expect(await shipToOf(orderId)).toBeNull();
  });

  it('stores one row per Market and refuses a stale version', async () => {
    const saved = await setting({ enabled: true, months: 36 });
    expect(saved).toMatchObject({ enabled: true, months: 36, version: 1 });
    expect(
      await new AdminSetShipToRetention(gate, deps).execute(admin(), {
        enabled: false,
        months: 12,
        expectedVersion: 0,
      }),
    ).toEqual({ ok: false, error: { code: 'conflict.retry' } });
    const read = await new AdminViewShipToRetention(gate, deps).execute(admin(other), {});
    expect(read.ok && read.value.version).toBe(0);
  });

  it('holds the CHECKs: months 1 to 120, a version of 1 or more', async () => {
    const insert = (months: number, version: number) =>
      owner.query(
        `INSERT INTO ordering.ship_to_retention_settings
           (id, market_id, tenant_id, enabled, months, version, updated_at, updated_by_account_id)
         VALUES ($1, $2, 'default', false, $3, $4, now(), $5)`,
        [ids.next(), market.marketId, months, version, ids.next()],
      );
    await expect(insert(0, 1)).rejects.toMatchObject({ code: CHECK });
    await expect(insert(121, 1)).rejects.toMatchObject({ code: CHECK });
    await expect(insert(24, 0)).rejects.toMatchObject({ code: CHECK });
  });

  it('lets the application role clear the ship-to and edit the setting, nothing more', async () => {
    const orderId = await placed(['2026-01-01T00:00:00']);
    await setting({});
    await expect(
      sql.query(`UPDATE ordering.orders SET ship_to_ciphertext = NULL WHERE id = $1`, [orderId]),
    ).resolves.toBeDefined();
    await expect(
      sql.query(`UPDATE ordering.orders SET account_id = $2 WHERE id = $1`, [orderId, orderId]),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query(`UPDATE ordering.ship_to_retention_settings SET months = 12 WHERE market_id = $1`, [
        market.marketId,
      ]),
    ).resolves.toBeDefined();
    await expect(
      sql.query(`UPDATE ordering.ship_to_retention_settings SET market_id = 'XX'`),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query(`DELETE FROM ordering.ship_to_retention_settings`),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query(`DELETE FROM ordering.orders WHERE id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: DENIED });
  });
});
