import { randomUUID } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
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
// are never deleted, so every test writes its own window far from the others' instants.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('promotions discount cost in market %s (database)', (code) => {
  const market = marketOf(code);
  const currency = new ConfigPromotionsPolicy(markets).settings(market)!.currency;
  const ids = new UuidV7IdGenerator(new FixedClock(Temporal.Instant.from('2026-11-25T00:00:00Z')));
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
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

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    facade = new PromotionsReportingFacadeImplementation(
      new SumDiscountCost(gate, {
        unitOfWork: db.unitOfWork,
        redemptions: new PrismaRedemptionRepository(db.service),
      }),
    );
  });
  afterAll(async () => {
    await db.close();
    await owner.end();
  });

  /** Writes one redemption RESERVED, then moves it the way the app does (confirm, release). */
  const redemption = async (row: {
    orderId: string;
    kind: 'ORDER' | 'FIRST_ORDER' | 'FREE_SHIPPING';
    platform?: number;
    confirmedAt: Temporal.Instant | null;
    released?: boolean;
    currency?: string;
    tenant?: string;
  }) => {
    const key =
      row.kind === 'ORDER'
        ? 'order'
        : row.kind === 'FIRST_ORDER'
          ? 'first-order'
          : 'free-shipping:metro';
    const amount = row.kind === 'ORDER' ? 0 : (row.platform ?? 0);
    const reservedAt = (row.confirmedAt ?? Temporal.Instant.from('2031-01-01T00:00:00Z')).subtract({
      minutes: 10,
    });
    const id = randomUUID();
    await owner.query(
      `INSERT INTO promotions.redemptions (id, market_id, tenant_id, order_id, promotion_key, kind,
         customer_account_id, currency, amount_minor, seller_share_minor, platform_share_minor,
         budget_month, status, reserved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $9, $10, 'RESERVED', $11)`,
      [
        id,
        market.marketId,
        row.tenant ?? market.tenantId,
        row.orderId,
        key,
        row.kind,
        randomUUID(),
        row.currency ?? currency,
        amount,
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
    // A window of its own per Market fixture, so other tests' rows never fall in it.
    const from = Temporal.Instant.from(
      code === TEST_MARKETS[0] ? '2031-03-01T00:00:00Z' : '2031-04-01T00:00:00Z',
    );
    const to = from.add({ hours: 24 * 7 });
    const inside = from.add({ hours: 30 });
    const kept1 = randomUUID();
    const kept2 = randomUUID();
    const refunded = randomUUID();
    await redemption({ orderId: kept1, kind: 'ORDER', confirmedAt: inside });
    await redemption({ orderId: kept1, kind: 'FIRST_ORDER', platform: 1_500, confirmedAt: inside });
    await redemption({ orderId: kept1, kind: 'FREE_SHIPPING', platform: 900, confirmedAt: inside });
    await redemption({ orderId: kept2, kind: 'ORDER', confirmedAt: from });
    await redemption({ orderId: kept2, kind: 'FREE_SHIPPING', platform: 600, confirmedAt: from });
    await redemption({ orderId: refunded, kind: 'ORDER', confirmedAt: inside, released: true });
    await redemption({
      orderId: refunded,
      kind: 'FIRST_ORDER',
      platform: 700,
      confirmedAt: inside,
      released: true,
    });
    // Left out: confirmed at the window's end, still reserved, another currency or tenant.
    const outside = randomUUID();
    await redemption({ orderId: outside, kind: 'ORDER', confirmedAt: to });
    await redemption({ orderId: outside, kind: 'FREE_SHIPPING', platform: 50, confirmedAt: to });
    await redemption({
      orderId: randomUUID(),
      kind: 'FREE_SHIPPING',
      platform: 50,
      confirmedAt: null,
    });
    await redemption({
      orderId: randomUUID(),
      kind: 'FREE_SHIPPING',
      platform: 50,
      confirmedAt: inside,
      currency: currency === 'NZD' ? 'AUD' : 'NZD',
    });
    await redemption({
      orderId: randomUUID(),
      kind: 'FREE_SHIPPING',
      platform: 50,
      confirmedAt: inside,
      tenant: 'other-tenant',
    });

    const out = await facade.discountCost(admin, { window: { from, to }, currency });
    expect(out).toEqual({
      ok: true,
      value: {
        kept: { orders: 2, amount: 3_000n, platformShare: 3_000n, sellerShare: 0n },
        byKind: [
          { kind: 'PROMOTION', uses: 0, amount: 0n, platformShare: 0n, sellerShare: 0n },
          { kind: 'FIRST_ORDER', uses: 1, amount: 1_500n, platformShare: 1_500n, sellerShare: 0n },
          {
            kind: 'FREE_SHIPPING',
            uses: 2,
            amount: 1_500n,
            platformShare: 1_500n,
            sellerShare: 0n,
          },
        ],
        released: { orders: 1, amount: 700n, platformShare: 700n, sellerShare: 0n },
      },
    });
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
    // With a sequential scan ruled out the planner can answer the grouped read from the index; on
    // a test table this small it would otherwise pick a scan of the whole table.
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL enable_seqscan = off');
      const plan = (
        await owner.query(
          `EXPLAIN SELECT kind, status, count(*), sum(amount_minor) FROM promotions.redemptions
            WHERE market_id = $1 AND tenant_id = $2 AND currency = $3
              AND confirmed_at >= $4 AND confirmed_at < $5
            GROUP BY kind, status`,
          [
            market.marketId,
            market.tenantId,
            currency,
            '2031-03-01T00:00:00Z',
            '2031-03-08T00:00:00Z',
          ],
        )
      ).rows
        .map((row: Record<string, string>) => row['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain('redemptions_confirmed_idx');
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
