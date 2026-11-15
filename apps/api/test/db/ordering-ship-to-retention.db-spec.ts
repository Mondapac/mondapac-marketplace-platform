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
import { PurgeDeliveredShipTo } from '../../src/modules/ordering/application/use-cases/purge-delivered-ship-to.use-case';
import { ORDERING_AUDIT_ACTIONS } from '../../src/modules/ordering/domain/audit';
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
// all delivered at least `months` months ago in the Market's zone; an order with a seller order not
// delivered keeps it; a second run clears nothing; no Market reaches another's orders; the CHECKs
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
    const result = await new PurgeDeliveredShipTo(gate, deps).execute(system(target), {});
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
  /** A confirmed order of `target` with one seller order per delivery (null: not delivered). */
  const placed = async (
    deliveries: (string | null)[],
    target: MarketContext = market,
  ): Promise<Id<'Order'>> => {
    const orderId = ids.next<'Order'>();
    const sellerOrders = deliveries.map(() => sellerOrder());
    const state: OrderState = {
      id: orderId,
      marketId: target.marketId,
      accountId: ids.next<'Account'>(),
      status: 'confirmed',
      cancelReason: null,
      paymentState: 'captured',
      total: money(1000n * BigInt(deliveries.length), currency(target)),
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
        quantity: 1,
        unitPrice: money(1000n, currency(target)),
        lineAmount: 1000n,
        taxInclusive: true,
        reservationLineId: ids.next<'ReservationLine'>(),
        commissionRateBps: 1500,
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
    for (const [index, at] of deliveries.entries()) {
      if (at === null) continue;
      const delivered = local(at);
      await owner.query(
        `UPDATE ordering.seller_orders
            SET fulfilment = 'delivered', carrier = 'Test courier', shipped_at = $2, delivered_at = $3
          WHERE id = $1`,
        [
          state.sellerOrders[index]!.id,
          delivered.subtract({ hours: 2 }).toString(),
          delivered.toString(),
        ],
      );
    }
    return orderId;
  };
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

  it('does nothing while never set or off', async () => {
    const old = await placed(['2020-01-01T00:00:00']);
    expect(await purge()).toEqual({ outcome: 'disabled', cleared: 0 });
    await setting({ enabled: false });
    expect(await purge()).toEqual({ outcome: 'disabled', cleared: 0 });
    expect(await shipToOf(old)).toBe(`v1.ship-to-of-${old}`);
  });

  it("clears orders all delivered 24 months ago in the Market's zone, and nothing else", async () => {
    const due = await placed(['2024-11-15T03:00:00']);
    const early = await placed(['2024-11-16T03:00:00']);
    const undelivered = await placed(['2021-06-01T00:00:00', null]);
    const twoOld = await placed(['2021-06-01T00:00:00', '2023-01-01T00:00:00']);
    const foreign = await placed(['2020-01-01T00:00:00'], other);
    const before = (await purgeAudits()).length;
    await setting({ enabled: true, months: 24 });

    const first = await purge();

    expect(first.outcome).toBe('complete');
    expect(first.cleared).toBeGreaterThanOrEqual(2);
    expect(await shipToOf(due)).toBeNull();
    expect(await shipToOf(twoOld)).toBeNull();
    expect(await shipToOf(early)).toBe(`v1.ship-to-of-${early}`);
    expect(await shipToOf(undelivered)).toBe(`v1.ship-to-of-${undelivered}`);
    expect(await shipToOf(foreign)).toBe(`v1.ship-to-of-${foreign}`);
    // Idempotent: the second run finds nothing more, and says so in its own audit row.
    expect(await purge()).toEqual({ outcome: 'complete', cleared: 0 });
    const audits = (await purgeAudits()).slice(before);
    expect(audits.map((a) => [a.months, a.cleared])).toEqual([
      [24, first.cleared],
      [24, 0],
    ]);
    expect(JSON.stringify(audits)).not.toContain(due);
  });

  it('pages by (confirmed_at, id) with a cursor, ties included, until a short batch', async () => {
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
        ok(await deps.retention.clearDeliveredShipTo(market, cutoff, from, 2)),
      );
      if (!batch.ok) throw new Error('batch failed');
      sizes.push(batch.value.cleared);
      after = batch.value.next;
      if (after === null) break;
    }
    expect(sizes.every((size) => size <= 2)).toBe(true);
    expect(sizes.at(-1)).toBeLessThan(2);
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
