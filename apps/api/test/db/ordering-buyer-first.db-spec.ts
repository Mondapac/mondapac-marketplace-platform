import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeOrderProducts, FakePromotions } from '../support/ordering-promotions-fakes';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ConfirmPayment } from '../../src/modules/ordering/application/use-cases/confirm-payment.use-case';
import type { OrderingDependencies } from '../../src/modules/ordering/application/checkout-flow';
import { ORDERING_EVENTS } from '../../src/modules/ordering/domain/events';
import { confirmOrder, type OrderState } from '../../src/modules/ordering/domain/order';
import { testOrderingPolicy } from '../support/ordering-policy';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { PrismaPickupCodeRepository } from '../../src/modules/ordering/infrastructure/prisma-pickup-code.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
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
  NO_AUDIT,
  NO_REFUNDS,
} from '../support/ordering-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { buyerFirstOwnerTestDatabaseUrl, buyerFirstTestDatabaseUrl } from './test-database';

// The buyer-first flags of dashboards v2 on PostgreSQL, as the application role, for both Market
// fixtures: confirming a payment claims the buyer's first paid order in the Market and with each
// seller (INSERT ... ON CONFLICT DO NOTHING) and freezes the two flags on the seller orders in the
// same unit; two concurrent first payments of one buyer are never both first; an unpaid order
// claims nothing; and the migration's history backfill sets the claims and the flags from the
// earliest paid order (by payment time, ties by order id) without ever rewriting a known flag.
// Runs on its own copy of the database: the backfill reads and writes every paid order there.

const T0 = Temporal.Instant.from('2026-11-20T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const MIGRATION = path.resolve(
  __dirname,
  '../../../../prisma/migrations/20261124020000_ordering_buyer_first_orders/migration.sql',
);

/** The history backfill part of the migration, as it runs there. */
const backfillSql = (): string => {
  const text = readFileSync(MIGRATION, 'utf8');
  const start = text.indexOf('-- Backfill the claims');
  const end = text.indexOf('-- Both flags or neither');
  if (start < 0 || end < start) throw new Error('the backfill part of the migration moved');
  return text.slice(start, end);
};

const OPS_SCRIPT = path.resolve(
  __dirname,
  '../../../../scripts/db/ordering-buyer-first-backfill.sql',
);

/** The statements of a SQL text without its comment lines (and psql meta-commands). */
const statementsOf = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('--') && !line.startsWith('\\'))
    .join('\n')
    .trim();

/** The ops script run after the deploy, as psql runs it (its meta-commands left out). */
const opsScriptSql = (): string => statementsOf(readFileSync(OPS_SCRIPT, 'utf8'));

interface FlagRow {
  readonly seller_id: string;
  readonly buyer_first_order: boolean | null;
  readonly buyer_first_with_seller: boolean | null;
}

describe.each(TEST_MARKETS)('buyer-first flags in market %s (database)', (code) => {
  const market = marketOf(code);
  const otherCode = TEST_MARKETS.find((candidate) => candidate !== code)!;
  const other = marketOf(otherCode);
  const currencyOf = (target: MarketContext) => (target.marketId === 'AU' ? 'AUD' : 'JPY');
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let sql: Client;
  let orders: PrismaOrderRepository;
  let deps: OrderingDependencies;
  let inventory: FakeInventory;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: buyerFirstTestDatabaseUrl() });
    sql = new Client({ connectionString: buyerFirstOwnerTestDatabaseUrl() });
    await sql.connect();
    orders = new PrismaOrderRepository(db.service);
    const catalogue = new EventCatalogue();
    catalogue.register('ordering', ORDERING_EVENTS);
    catalogue.seal();
    inventory = new FakeInventory();
    deps = {
      unitOfWork: db.unitOfWork,
      orders,
      refunds: NO_REFUNDS,
      audit: NO_AUDIT,
      gateway: new FakeGateway(),
      policy: testOrderingPolicy(markets),
      cart: new FakeCart(),
      customers: new FakeCustomers(),
      shipTo: new FakeShipToCipher(),
      inventory,
      shipping: new FakeShipping(),
      commission: new FakeCommission(),
      tax: new FakeTax(),
      taxCategories: new FakeTaxCategories('taxable'),
      products: new FakeOrderProducts(),
      promotions: new FakePromotions(),
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('ordering'),
      ids,
      clock,
      labels: new FakeLabels(),
      deliveryMethods: new AllowAllDeliveryMethods(),
      pickupCodes: new PrismaPickupCodeRepository(db.service),
      pickupVault: new FakePickupVault(),
      attempts: new FakeAttemptLimits(),
    };
  });
  afterEach(() => {
    inventory.commitFails = null;
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const systemOf = (target: MarketContext): CallContext =>
    testCallContext(target, 'system', `buyer-first-${ids.next()}`);

  /** An order of `accountId` with one seller order per seller; pending unless `paidAt` is given. */
  const orderOf = (
    target: MarketContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
    paidAt: Temporal.Instant | null = null,
    orderId: Id<'Order'> = ids.next<'Order'>(),
  ): OrderState => {
    const currency = currencyOf(target);
    const sellerOrderIds = sellerIds.map(() => ids.next<'SellerOrder'>());
    return {
      id: orderId,
      marketId: target.marketId,
      accountId,
      status: paidAt === null ? 'pending-payment' : 'confirmed',
      cancelReason: null,
      paymentState: paidAt === null ? 'none' : 'captured',
      total: money(1250n * BigInt(sellerIds.length), currency),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: `cs_${orderId}`,
      stripePaymentIntentId: paidAt === null ? null : `pi_${orderId}`,
      paymentExpiresAt: T0.add({ minutes: 30 }),
      createdAt: paidAt ?? T0,
      confirmedAt: paidAt,
      cancelledAt: null,
      version: 1,
      taxStrategyId: null,
      shipToSealed: null,
      sellerOrders: sellerOrderIds.map((id, index) => ({
        id,
        sellerId: sellerIds[index]!,
        subtotal: 1250n,
        shipping: 0n,
        discount: 0n,
        shippingDiscount: 0n,
        shippingTaxRateBps: null,
        shippingTax: null,
        shippingTaxInclusive: null,
        total: 1250n,
        fulfilment: 'to-ship' as const,
        carrier: null,
        trackingRef: null,
        shippedAt: null,
        deliveredAt: null,
        inventoryRecordedAt: null,
        cancelledAt: null,
        ledgerState: 'pending' as const,
        deliveryMethod: 'instant' as const,
        deliveryWindow: null,
        readyAt: null,
        readyPrepMinutes: null,
        deliveryAttention: null,
        deliveryQuote: null,
        buyerFirst: null,
      })),
      lines: sellerOrderIds.map((sellerOrderId) => ({
        id: ids.next<'OrderLine'>(),
        sellerOrderId,
        offerId: ids.next<'Offer'>(),
        variantId: ids.next<'Variant'>(),
        quantity: 1,
        unitPrice: money(1250n, currency),
        lineAmount: 1250n,
        discountAmount: 0n,
        discountSellerShare: 0n,
        discountPlatformShare: 0n,
        taxInclusive: true,
        reservationLineId: ids.next<'ReservationLine'>(),
        commissionRateBps: 1500,
        commissionRateReason: 'standard',
        exclusiveSeller: false,
        taxRateBps: 1000,
        taxAmount: 114n,
        taxCategoryCode: 'taxable',
      })),
    };
  };
  const store = async (target: MarketContext, order: OrderState): Promise<OrderState> => {
    const stored = await db.unitOfWork.run(target, async () => {
      await orders.insert(target, order);
      return ok(undefined);
    });
    if (!stored.ok) throw new Error('could not store the order');
    return order;
  };
  const place = (
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
    target: MarketContext = market,
  ) => store(target, orderOf(target, accountId, sellerIds));
  const confirm = (order: OrderState, target: MarketContext = market) =>
    new ConfirmPayment(gate, deps).execute(systemOf(target), {
      orderId: order.id,
      paymentIntentId: `pi_${order.id}`,
      sessionId: `cs_${order.id}`,
      amount: order.total,
    });
  const flagsOf = async (order: OrderState, target: MarketContext = market) =>
    Object.fromEntries(
      (
        await sql.query<FlagRow>(
          `SELECT seller_id::text, buyer_first_order, buyer_first_with_seller
             FROM ordering.seller_orders WHERE market_id = $1 AND order_id = $2`,
          [target.marketId, order.id],
        )
      ).rows.map((row) => [
        row.seller_id,
        row.buyer_first_order === null
          ? null
          : { order: row.buyer_first_order, withSeller: row.buyer_first_with_seller },
      ]),
    );
  const claimsOf = async (accountId: Id<'Account'>, target: MarketContext = market) => ({
    first: (
      await sql.query<{ order_id: string }>(
        `SELECT order_id::text FROM ordering.buyer_first_orders
          WHERE market_id = $1 AND tenant_id = $2 AND account_id = $3`,
        [target.marketId, target.tenantId, accountId],
      )
    ).rows.map((row) => row.order_id),
    withSeller: Object.fromEntries(
      (
        await sql.query<{ seller_id: string; order_id: string }>(
          `SELECT seller_id::text, order_id::text FROM ordering.buyer_first_seller_orders
            WHERE market_id = $1 AND tenant_id = $2 AND account_id = $3`,
          [target.marketId, target.tenantId, accountId],
        )
      ).rows.map((row) => [row.seller_id, row.order_id]),
    ),
  });
  const FIRST = { order: true, withSeller: true };
  const RETURNING = { order: false, withSeller: false };
  const NEW_TO_SELLER = { order: false, withSeller: true };

  it('freezes the first order, then a returning order with the same and with another seller', async () => {
    const buyer = ids.next<'Account'>();
    const [s1, s2, s3] = [ids.next<'Seller'>(), ids.next<'Seller'>(), ids.next<'Seller'>()];
    const first = await place(buyer, [s1, s2]);
    expect(await flagsOf(first)).toEqual({ [s1]: null, [s2]: null });

    expect(await confirm(first)).toEqual(ok('confirmed'));
    expect(await flagsOf(first)).toEqual({ [s1]: FIRST, [s2]: FIRST });

    const second = await place(buyer, [s1, s3]);
    expect(await confirm(second)).toEqual(ok('confirmed'));
    expect(await flagsOf(second)).toEqual({ [s1]: RETURNING, [s3]: NEW_TO_SELLER });
    // The first order keeps its flags; the repository reads them back.
    expect(await flagsOf(first)).toEqual({ [s1]: FIRST, [s2]: FIRST });
    const read = await db.unitOfWork.run(
      market,
      async () => ok(await orders.findById(market, second.id)),
      { readOnly: true },
    );
    expect(
      read.ok &&
        Object.fromEntries(read.value!.sellerOrders.map((so) => [so.sellerId, so.buyerFirst])),
    ).toEqual({ [s1]: RETURNING, [s3]: NEW_TO_SELLER });

    expect(await claimsOf(buyer)).toEqual({
      first: [first.id],
      withSeller: { [s1]: first.id, [s2]: first.id, [s3]: second.id },
    });
    // A repeated delivery changes nothing.
    expect(await confirm(second)).toEqual(ok('already-confirmed'));
    expect(await flagsOf(second)).toEqual({ [s1]: RETURNING, [s3]: NEW_TO_SELLER });
  });

  it('never makes two concurrent first payments of one buyer both first', async () => {
    const buyer = ids.next<'Account'>();
    const [s1, s2] = [ids.next<'Seller'>(), ids.next<'Seller'>()];
    // Same seller on both, and a seller of its own on the second.
    const a = await place(buyer, [s1]);
    const b = await place(buyer, [s1, s2]);

    const results = await Promise.all([confirm(a), confirm(b)]);
    expect(results).toEqual([ok('confirmed'), ok('confirmed')]);

    const flags = { a: await flagsOf(a), b: await flagsOf(b) };
    const claims = await claimsOf(buyer);
    expect(claims.first).toHaveLength(1);
    const winner = claims.first[0] === a.id ? 'a' : 'b';
    expect(claims.first[0]).toBe(winner === 'a' ? a.id : b.id);
    expect(claims.withSeller[s1]).toBe(claims.first[0]);
    expect(claims.withSeller[s2]).toBe(b.id);
    if (winner === 'a') {
      expect(flags).toEqual({ a: { [s1]: FIRST }, b: { [s1]: RETURNING, [s2]: NEW_TO_SELLER } });
    } else {
      expect(flags).toEqual({ a: { [s1]: RETURNING }, b: { [s1]: FIRST, [s2]: FIRST } });
    }
  });

  it('makes the second of two overlapping confirming units wait for the first and lose', async () => {
    const buyer = ids.next<'Account'>();
    const s1 = ids.next<'Seller'>();
    const a = await place(buyer, [s1]);
    const b = await place(buyer, [s1]);
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
    let aClaimed!: () => void;
    const aHasClaimed = new Promise<void>((resolve) => (aClaimed = resolve));
    // The confirming unit as payment-flow runs it: save the confirmation, then claim.
    const confirmUnit = (order: OrderState, beforeCommit: () => Promise<void>) =>
      db.unitOfWork.run(market, async () => {
        const found = (await orders.findById(market, order.id))!;
        const next = confirmOrder(found, T0)!;
        expect(await orders.save(market, next)).toBe('saved');
        const flagged = await orders.claimBuyerFirst(market, {
          ...next,
          version: next.version + 1,
        });
        await beforeCommit();
        return ok(flagged.sellerOrders[0]!.buyerFirst);
      });

    const first = confirmUnit(a, async () => {
      aClaimed();
      await aMayCommit;
    });
    await aHasClaimed;
    // B reads before A commits (it sees only its own payment), then waits on A's claim key.
    const second = confirmUnit(b, () => Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseA();

    expect(await first).toEqual(ok(FIRST));
    expect(await second).toEqual(ok(RETURNING));
    expect(await claimsOf(buyer)).toEqual({ first: [a.id], withSeller: { [s1]: a.id } });
  });

  it('claims nothing for an order whose payment is voided', async () => {
    const buyer = ids.next<'Account'>();
    const s1 = ids.next<'Seller'>();
    const voided = await place(buyer, [s1]);
    inventory.commitFails = { code: 'inventory.insufficient', details: { lines: [] } };
    expect(await confirm(voided)).toEqual(ok('voided'));
    inventory.commitFails = null;

    expect(await flagsOf(voided)).toEqual({ [s1]: null });
    expect(await claimsOf(buyer)).toEqual({ first: [], withSeller: {} });

    const paid = await place(buyer, [s1]);
    expect(await confirm(paid)).toEqual(ok('confirmed'));
    expect(await flagsOf(paid)).toEqual({ [s1]: FIRST });
  });

  it("keeps each Market's claims apart", async () => {
    // The same account id in two Markets (accounts are Market-scoped; the claim key names both).
    const buyer = ids.next<'Account'>();
    const s1 = ids.next<'Seller'>();
    const here = await place(buyer, [s1]);
    const there = await place(buyer, [s1], other);
    expect(await confirm(here)).toEqual(ok('confirmed'));
    expect(await confirm(there, other)).toEqual(ok('confirmed'));
    expect(await flagsOf(here)).toEqual({ [s1]: FIRST });
    expect(await flagsOf(there, other)).toEqual({ [s1]: FIRST });
  });

  it('claims from the earliest paid order: one paid without a claim stays the first', async () => {
    // Paid by the previous release between the migration and the deploy: no claim, no flags.
    const buyer = ids.next<'Account'>();
    const s1 = ids.next<'Seller'>();
    const gap = await store(market, orderOf(market, buyer, [s1], T0.subtract({ hours: 2 })));
    const later = await place(buyer, [s1]);
    expect(await confirm(later)).toEqual(ok('confirmed'));
    expect(await flagsOf(later)).toEqual({ [s1]: RETURNING });
    expect(await claimsOf(buyer)).toEqual({ first: [gap.id], withSeller: { [s1]: gap.id } });
    // The gap order itself stays unknown until the backfill runs again (next test).
    expect(await flagsOf(gap)).toEqual({ [s1]: null });
  });

  it('backfills claims and flags from the earliest paid order, never rewriting a known flag', async () => {
    const [buyer, tied, known] = [
      ids.next<'Account'>(),
      ids.next<'Account'>(),
      ids.next<'Account'>(),
    ];
    const [s1, s2, s3] = [ids.next<'Seller'>(), ids.next<'Seller'>(), ids.next<'Seller'>()];
    // Inserted out of payment order: the earliest payment wins, not the earliest insert.
    const late = await store(market, orderOf(market, buyer, [s1, s3], T0.subtract({ hours: 1 })));
    const early = await store(market, orderOf(market, buyer, [s1, s2], T0.subtract({ hours: 5 })));
    // An unpaid order before both: it claims nothing.
    const unpaid = await store(market, orderOf(market, buyer, [s3], null, ids.next<'Order'>()));
    // Two orders paid at the same instant: the lower order id wins.
    // The higher id is stored first.
    const [lowId, highId] = [ids.next<'Order'>(), ids.next<'Order'>()].sort() as [
      Id<'Order'>,
      Id<'Order'>,
    ];
    const at = T0.subtract({ hours: 3 });
    const high = await store(market, orderOf(market, tied, [s1], at, highId));
    const low = await store(market, orderOf(market, tied, [s1], at, lowId));
    // A known flag that the backfill would compute otherwise: it is kept.
    const kept = await store(market, orderOf(market, known, [s1], T0.subtract({ hours: 4 })));
    await sql.query(
      `UPDATE ordering.seller_orders SET buyer_first_order = false, buyer_first_with_seller = false
        WHERE market_id = $1 AND order_id = $2`,
      [market.marketId, kept.id],
    );

    await sql.query(backfillSql());

    expect(await flagsOf(early)).toEqual({ [s1]: FIRST, [s2]: FIRST });
    expect(await flagsOf(late)).toEqual({ [s1]: RETURNING, [s3]: NEW_TO_SELLER });
    expect(await flagsOf(unpaid)).toEqual({ [s3]: null });
    expect(await claimsOf(buyer)).toEqual({
      first: [early.id],
      withSeller: { [s1]: early.id, [s2]: early.id, [s3]: late.id },
    });
    expect(await flagsOf(low)).toEqual({ [s1]: FIRST });
    expect(await flagsOf(high)).toEqual({ [s1]: RETURNING });
    expect(await flagsOf(kept)).toEqual({ [s1]: RETURNING });
    expect((await claimsOf(known)).first).toEqual([kept.id]);

    // The ops script holds the migration's statements, and running it again moves nothing.
    expect(opsScriptSql()).toContain(statementsOf(backfillSql()));
    const before = await sql.query(
      `SELECT id, buyer_first_order, buyer_first_with_seller FROM ordering.seller_orders ORDER BY id`,
    );
    await sql.query(opsScriptSql());
    const after = await sql.query(
      `SELECT id, buyer_first_order, buyer_first_with_seller FROM ordering.seller_orders ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);
    // Every paid seller order now has its flags, the gap order of the previous test included.
    const unknown = await sql.query(
      `SELECT count(*)::int AS n FROM ordering.seller_orders
        WHERE paid_at IS NOT NULL AND buyer_first_order IS NULL`,
    );
    expect(unknown.rows).toEqual([{ n: 0 }]);
  });

  it('holds the flags to the CHECK: both or neither, only when paid, first implies first with seller', async () => {
    const pending = await place(ids.next<'Account'>(), [ids.next<'Seller'>()]);
    const paid = await store(
      market,
      orderOf(market, ids.next<'Account'>(), [ids.next<'Seller'>()], T0.subtract({ hours: 6 })),
    );
    const update = (orderId: string, first: boolean | null, withSeller: boolean | null) =>
      sql.query(
        `UPDATE ordering.seller_orders SET buyer_first_order = $3, buyer_first_with_seller = $4
          WHERE market_id = $1 AND order_id = $2`,
        [market.marketId, orderId, first, withSeller],
      );
    const refused = { code: '23514', constraint: 'seller_orders_buyer_first_check' };
    await expect(update(pending.id, false, false)).rejects.toMatchObject(refused);
    await expect(update(paid.id, true, null)).rejects.toMatchObject(refused);
    await expect(update(paid.id, true, false)).rejects.toMatchObject(refused);
    await expect(update(paid.id, false, true)).resolves.toBeDefined();
  });
});
