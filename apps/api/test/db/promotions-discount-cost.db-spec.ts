import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { SumDiscountCost } from '../../src/modules/promotions/application/use-cases/sum-discount-cost.use-case';
import { ConfigPromotionsPolicy } from '../../src/modules/promotions/infrastructure/config-promotions-policy';
import { PrismaRedemptionRepository } from '../../src/modules/promotions/infrastructure/prisma-redemption.repository';
import { PromotionsReportingFacadeImplementation } from '../../src/modules/promotions/presentation/promotions-reporting.facade';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Dashboards v2, phase 2: promotions.sum-discount-cost on the real store in both Market fixtures.
// The grouped read sums the redemptions whose payment was confirmed in the window (head rows count
// the orders, released rows apart, other windows, currencies and tenants left out), and the
// partial index redemptions_confirmed_idx exists, is valid and serves the window's range. Rows
// are never deleted, so every test writes under a tenant of its own (and its own window), and a
// rerun on the same database never meets an earlier run's rows.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('promotions discount cost in market %s (database)', (code) => {
  const market = marketOf(code);
  const currency = new ConfigPromotionsPolicy(markets).settings(market)!.currency;
  const ids = new UuidV7IdGenerator(new FixedClock(Temporal.Instant.from('2026-11-25T00:00:00Z')));
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  /** A tenant of the test's own (the column's pattern), so no other run's rows are summed. */
  const freshTenant = (): MarketContext =>
    testMarketContext(code, `t${randomUUID().replace(/-/g, '').slice(0, 20)}`);
  const adminOf = (tenant: MarketContext): CallContext =>
    testCallContext(
      tenant,
      testAuthenticatedActor(tenant, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'discount-cost-db-admin',
    );

  let db: Persistence;
  let owner: Client;
  let facade: PromotionsReportingFacadeImplementation;
  let repository: PrismaRedemptionRepository;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    repository = new PrismaRedemptionRepository(db.service);
    facade = new PromotionsReportingFacadeImplementation(
      new SumDiscountCost(gate, { unitOfWork: db.unitOfWork, redemptions: repository }),
    );
  });
  afterAll(async () => {
    await db.close();
    await owner.end();
  });

  /** Writes one redemption RESERVED, then moves it the way the app does (confirm, release). */
  const redemption = async (row: {
    tenant: MarketContext;
    orderId: string;
    kind: 'ORDER' | 'FIRST_ORDER' | 'FREE_SHIPPING';
    platform?: number;
    seller?: number;
    confirmedAt: Temporal.Instant | null;
    released?: boolean;
    currency?: string;
  }) => {
    const key =
      row.kind === 'ORDER'
        ? 'order'
        : row.kind === 'FIRST_ORDER'
          ? 'first-order'
          : 'free-shipping:metro';
    const platform = row.kind === 'ORDER' ? 0 : (row.platform ?? 0);
    const seller = row.kind === 'ORDER' ? 0 : (row.seller ?? 0);
    const reservedAt = (row.confirmedAt ?? Temporal.Instant.from('2031-01-01T00:00:00Z')).subtract({
      minutes: 10,
    });
    const id = randomUUID();
    await owner.query(
      `INSERT INTO promotions.redemptions (id, market_id, tenant_id, order_id, promotion_key, kind,
         customer_account_id, currency, amount_minor, seller_share_minor, platform_share_minor,
         budget_month, status, reserved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'RESERVED', $13)`,
      [
        id,
        market.marketId,
        row.tenant.tenantId,
        row.orderId,
        key,
        row.kind,
        randomUUID(),
        row.currency ?? currency,
        platform + seller,
        seller,
        platform,
        row.kind === 'FIRST_ORDER' ? '2031-03' : null,
        reservedAt.toString(),
      ],
    );
    if (row.confirmedAt !== null) {
      await owner.query(
        `UPDATE promotions.redemptions SET status = 'CONFIRMED', confirmed_at = $2 WHERE id = $1`,
        [id, row.confirmedAt.toString()],
      );
    }
    if (row.released === true) {
      await owner.query(
        `UPDATE promotions.redemptions SET status = 'RELEASED', release_reason = 'ORDER_REFUNDED',
           released_at = $2 WHERE id = $1`,
        [id, row.confirmedAt!.add({ hours: 1 }).toString()],
      );
    }
  };

  it('sums the confirmed discounts of the window by kind, with the orders and the given-back apart', async () => {
    const tenant = freshTenant();
    const other = freshTenant();
    // A window of its own per Market fixture, so other tests' rows never fall in it.
    const from = Temporal.Instant.from(
      code === TEST_MARKETS[0] ? '2031-03-01T00:00:00Z' : '2031-04-01T00:00:00Z',
    );
    const to = from.add({ hours: 24 * 7 });
    const inside = from.add({ hours: 30 });
    const kept1 = randomUUID();
    const kept2 = randomUUID();
    const refunded = randomUUID();
    const row = (fields: Omit<Parameters<typeof redemption>[0], 'tenant'>) =>
      redemption({ tenant, ...fields });
    await row({ orderId: kept1, kind: 'ORDER', confirmedAt: inside });
    await row({ orderId: kept1, kind: 'FIRST_ORDER', platform: 1_500, confirmedAt: inside });
    await row({ orderId: kept1, kind: 'FREE_SHIPPING', platform: 900, confirmedAt: inside });
    await row({ orderId: kept2, kind: 'ORDER', confirmedAt: from });
    // A seller funds part of this one: the shares are summed apart.
    await row({
      orderId: kept2,
      kind: 'FREE_SHIPPING',
      platform: 600,
      seller: 300,
      confirmedAt: from,
    });
    // Refunded after payment, released the way the app does: the whole order, confirmed rows too.
    await row({ orderId: refunded, kind: 'ORDER', confirmedAt: inside });
    await row({ orderId: refunded, kind: 'FIRST_ORDER', platform: 700, confirmedAt: inside });
    const released = await db.unitOfWork.run(tenant, async () =>
      ok(
        await repository.release(
          tenant,
          refunded as Id<'Order'>,
          'ORDER_REFUNDED',
          inside.add({ hours: 1 }),
          true,
        ),
      ),
    );
    expect(released.ok && released.value.length).toBe(2);
    // Left out: confirmed at the window's end, still reserved, another currency or tenant, and a
    // head row born RELEASED by a cancellation before redemption (no currency, never confirmed).
    const outside = randomUUID();
    await row({ orderId: outside, kind: 'ORDER', confirmedAt: to });
    await row({ orderId: outside, kind: 'FREE_SHIPPING', platform: 50, confirmedAt: to });
    await row({ orderId: randomUUID(), kind: 'FREE_SHIPPING', platform: 50, confirmedAt: null });
    await row({
      orderId: randomUUID(),
      kind: 'FREE_SHIPPING',
      platform: 50,
      confirmedAt: inside,
      currency: currency === 'NZD' ? 'AUD' : 'NZD',
    });
    await redemption({
      tenant: other,
      orderId: randomUUID(),
      kind: 'FREE_SHIPPING',
      platform: 50,
      confirmedAt: inside,
    });
    await owner.query(
      `INSERT INTO promotions.redemptions (id, market_id, tenant_id, order_id, promotion_key, kind,
         amount_minor, seller_share_minor, platform_share_minor, status, release_reason,
         reserved_at, released_at)
       VALUES ($1, $2, $3, $4, 'order', 'ORDER', 0, 0, 0, 'RELEASED', 'ORDER_CANCELLED', $5, $5)`,
      [randomUUID(), market.marketId, tenant.tenantId, randomUUID(), inside.toString()],
    );

    const out = await facade.discountCost(adminOf(tenant), { window: { from, to }, currency });
    expect(out).toEqual({
      ok: true,
      value: {
        kept: { orders: 2, amount: 3_300n, platformShare: 3_000n, sellerShare: 300n },
        byKind: [
          { kind: 'PROMOTION', uses: 0, amount: 0n, platformShare: 0n, sellerShare: 0n },
          { kind: 'FIRST_ORDER', uses: 1, amount: 1_500n, platformShare: 1_500n, sellerShare: 0n },
          {
            kind: 'FREE_SHIPPING',
            uses: 2,
            amount: 1_800n,
            platformShare: 1_500n,
            sellerShare: 300n,
          },
        ],
        released: { orders: 1, amount: 700n, platformShare: 700n, sellerShare: 0n },
      },
    });
    // The other tenant's admin sees its own row only.
    const theirs = await facade.discountCost(adminOf(other), { window: { from, to }, currency });
    expect(theirs.ok && theirs.value.byKind[2]).toMatchObject({ uses: 1, amount: 50n });
  });

  it('has the partial index valid, and it serves a window of confirmations', async () => {
    const [index] = (
      await owner.query(
        `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'promotions' AND c.relname = 'redemptions_confirmed_idx'`,
      )
    ).rows as { valid: boolean; def: string }[];
    expect(index?.valid).toBe(true);
    expect(index?.def).toContain('(market_id, confirmed_at) WHERE (confirmed_at IS NOT NULL)');
    // The index serves the window's range: with scans of the whole table, bitmaps and sorts
    // ruled out, the rows of one Market's window in confirmation order come from it alone. On a
    // test table this small the planner would otherwise pick any index on market_id, or none.
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL enable_seqscan = off');
      await owner.query('SET LOCAL enable_bitmapscan = off');
      await owner.query('SET LOCAL enable_sort = off');
      const plan = (
        await owner.query(
          `EXPLAIN SELECT kind, status, amount_minor FROM promotions.redemptions
            WHERE market_id = $1 AND confirmed_at >= $2 AND confirmed_at < $3
            ORDER BY confirmed_at`,
          [market.marketId, '2031-03-01T00:00:00Z', '2031-03-08T00:00:00Z'],
        )
      ).rows
        .map((row: Record<string, string>) => row['QUERY PLAN'])
        .join('\n');
      expect(plan).toMatch(/Index Scan using redemptions_confirmed_idx/);
      expect(plan).toMatch(/Index Cond: .*confirmed_at >=/);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
