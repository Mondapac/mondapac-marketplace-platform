import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CountAbandonedCarts } from '../../src/modules/cart/application/use-cases/count-abandoned-carts.use-case';
import type { CartState } from '../../src/modules/cart/domain/cart';
import { CryptoGuestTokens } from '../../src/modules/cart/infrastructure/crypto-guest-tokens';
import { PrismaAbandonedCartTotals } from '../../src/modules/cart/infrastructure/prisma-abandoned-cart-totals';
import { PrismaCartRepository } from '../../src/modules/cart/infrastructure/prisma-cart.repository';
import { CartReportingFacadeImplementation } from '../../src/modules/cart/presentation/cart-reporting.facade';
import { SnapshotAbandonedCarts } from '../../src/modules/reporting/application/use-cases/snapshot-abandoned-carts.use-case';
import { ViewMarketplaceAbandonedCarts } from '../../src/modules/reporting/application/use-cases/view-marketplace-abandoned-carts.use-case';
import type { MarketDay } from '../../src/modules/reporting/domain/facts';
import { FacadeAbandonedCartSources } from '../../src/modules/reporting/infrastructure/facade-abandoned-cart-sources';
import { PrismaAbandonedCartsStore } from '../../src/modules/reporting/infrastructure/prisma-abandoned-carts-store';
import { RegistryMarketZone } from '../../src/modules/reporting/infrastructure/registry-market-zone';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { abandonedCartsOwnerTestDatabaseUrl, abandonedCartsTestDatabaseUrl } from './test-database';

// Abandoned carts on PostgreSQL (dashboards v2, phase 2), both Market fixtures, on a database copy
// of their own (the count has no lower bound on the last change, so no other file's carts may live
// there): cart's totals as the application role count only ACTIVE carts with lines, no order mark
// and no change since the cutoff, of this Market, guest or account; reporting's snapshot writes the
// day once; the table holds no person and refuses UPDATE and DELETE to the application role.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK = '23514';
const DAY = '2026-05-10' as MarketDay;

describe.each(TEST_MARKETS)('abandoned carts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const zone = new RegistryMarketZone(markets);
  const tz = zone.zoneOf(market);
  const currency = zone.currencyOf(market);
  const otherCurrency = zone.currencyOf(other);
  const dayEnd = Temporal.PlainDate.from(DAY)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: tz })
    .toInstant();
  const cutoff = dayEnd.subtract({ hours: 24 });
  const clock = new FixedClock(dayEnd.add({ hours: 3 }));
  const ids = new UuidV7IdGenerator(clock);
  const tokens = new CryptoGuestTokens();
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system');
  let db: Persistence;
  let carts: PrismaCartRepository;
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: abandonedCartsTestDatabaseUrl() });
    carts = new PrismaCartRepository(db.service);
    owner = new Client({ connectionString: abandonedCartsOwnerTestDatabaseUrl() });
    app = new Client({ connectionString: abandonedCartsTestDatabaseUrl() });
    await owner.connect();
    await app.connect();
  });
  afterAll(async () => {
    await db.close();
    await owner.end();
    await app.end();
  });
  beforeEach(async () => {
    await owner.query(`DELETE FROM cart.carts WHERE market_id = ANY($1)`, [
      [market.marketId, other.marketId],
    ]);
    await owner.query(`DELETE FROM reporting.daily_abandoned_carts WHERE market_id = $1`, [
      market.marketId,
    ]);
  });

  const unit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const cart = (
    target: MarketContext,
    changed: Temporal.Instant,
    kind: 'account' | 'guest' | 'merged' = 'account',
    lines: readonly { quantity: number; price: bigint; currency?: string }[] = [
      { quantity: 1, price: 1000n },
    ],
  ): CartState => ({
    id: ids.next<'Cart'>(),
    marketId: target.marketId,
    owner:
      kind === 'account'
        ? { kind: 'account', accountId: ids.next<'Account'>() }
        : { kind: 'guest', tokenHash: tokens.issue().hash },
    status: kind === 'merged' ? 'merged' : 'active',
    lastChangedAt: changed,
    mergedIntoCartId: kind === 'merged' ? ids.next<'Cart'>() : null,
    mergedAt: kind === 'merged' ? changed : null,
    version: 1,
    createdAt: changed.subtract({ hours: 1 }),
    lines: lines.map((line) => ({
      id: ids.next<'CartLine'>(),
      offerId: ids.next<'Offer'>(),
      variantId: ids.next<'Variant'>(),
      quantity: line.quantity,
      priceAtAdd: money(line.price, line.currency ?? currency),
      addedAt: changed,
    })),
  });
  const insert = (target: MarketContext, state: CartState) =>
    unit(target, () => carts.insert(target, state));
  const facade = () =>
    new CartReportingFacadeImplementation(
      new CountAbandonedCarts(gate, {
        unitOfWork: db.unitOfWork,
        totals: new PrismaAbandonedCartTotals(db.service),
      }),
    );

  it('counts active carts with lines, untouched since the cutoff, of this Market only', async () => {
    const old = cutoff.subtract({ hours: 30 });
    await insert(
      market,
      cart(market, old, 'account', [
        { quantity: 2, price: 1500n },
        { quantity: 1, price: 250n },
      ]),
    );
    // Two lines of the same quantity in different carts: one group, its prices summed, times 2.
    await insert(
      market,
      cart(market, cutoff, 'guest', [
        { quantity: 3, price: 100n },
        { quantity: 2, price: 40n },
      ]),
    );
    // Left out: changed after the cutoff, merged, empty, left by a paid order, another Market's,
    // another tenant's.
    await insert(market, cart(market, cutoff.add({ seconds: 1 })));
    await insert(market, cart(market, old, 'merged'));
    await insert(market, cart(market, old, 'account', []));
    const ordered = cart(market, old);
    await insert(market, ordered);
    await unit(market, () => carts.markOrdered(market, ordered.id, old));
    await insert(other, cart(other, old));
    // Another tenant's cart in the same Market (moved there as the owner): left out too.
    const theirs = cart(market, old);
    await insert(market, theirs);
    await owner.query(`UPDATE cart.cart_lines SET tenant_id = 'other-tenant' WHERE cart_id = $1`, [
      theirs.id,
    ]);
    await owner.query(`UPDATE cart.carts SET tenant_id = 'other-tenant' WHERE id = $1`, [
      theirs.id,
    ]);

    expect(await facade().abandonedCarts(system, { changedAtOrBefore: cutoff })).toEqual({
      ok: true,
      value: {
        carts: 2,
        values: [{ amount: 2n * 1500n + 250n + 3n * 100n + 2n * 40n, currency }],
      },
    });
  });

  it('answers a sum per currency, never converted', async () => {
    const old = cutoff.subtract({ hours: 1 });
    await insert(
      market,
      cart(market, old, 'account', [
        { quantity: 1, price: 7n, currency: otherCurrency },
        { quantity: 1, price: 5n },
      ]),
    );
    const both = await facade().abandonedCarts(system, { changedAtOrBefore: cutoff });
    expect(both.ok && both.value.values).toEqual(
      [
        { amount: 5n, currency },
        { amount: 7n, currency: otherCurrency },
      ].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    );
  });

  it('writes the Market day once as the application role, and reads it for an admin', async () => {
    for (let n = 0; n < 6; n += 1) {
      await insert(market, cart(market, cutoff.subtract({ hours: 2 + n })));
    }
    const store = new PrismaAbandonedCartsStore(db.service);
    const snapshot = new SnapshotAbandonedCarts(gate, {
      unitOfWork: db.unitOfWork,
      store,
      sources: new FacadeAbandonedCartSources(facade()),
      zone,
      clock,
    });
    expect(await snapshot.execute(system, {})).toEqual({
      ok: true,
      value: { written: 1, alreadyWritten: 0, failedDays: 0 },
    });
    await insert(market, cart(market, cutoff.subtract({ hours: 1 })));
    expect(await snapshot.execute(system, {})).toMatchObject({ value: { written: 0 } });
    const rows = await owner.query<Record<string, unknown>>(
      `SELECT cart_count, approx_value_amount, approx_value_currency
         FROM reporting.daily_abandoned_carts WHERE market_id = $1 AND market_day = $2`,
      [market.marketId, DAY],
    );
    expect(rows.rows).toEqual([
      { cart_count: 6, approx_value_amount: '6000', approx_value_currency: currency },
    ]);

    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const view = new ViewMarketplaceAbandonedCarts(gate, {
      unitOfWork: db.unitOfWork,
      store,
      zone,
      clock,
    });
    const out = await view.execute(admin, { period: '7d' });
    expect(out.ok && out.value.abandonedCarts).toMatchObject({
      status: 'available',
      carts: 6,
      approximateValue: { amount: 6000n, currency },
      asOfDay: DAY,
    });
  });

  it('holds no person, is insert-only for the application, and keeps the value whole', async () => {
    const columns = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'reporting' AND table_name = 'daily_abandoned_carts'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names.sort()).toEqual(
      [
        'market_id',
        'tenant_id',
        'market_day',
        'cart_count',
        'approx_value_amount',
        'approx_value_currency',
        'recorded_at',
      ].sort(),
    );
    for (const name of names) {
      expect(name).not.toMatch(/account|customer|buyer|shopper|guest|owner|offer|seller|cart_id/);
    }
    const insertRow = (amount: string | null, currencyCode: string | null, count = 1) =>
      owner.query(
        `INSERT INTO reporting.daily_abandoned_carts
           (market_id, tenant_id, market_day, cart_count, approx_value_amount,
            approx_value_currency, recorded_at)
         VALUES ($1, $2, '2026-05-01', $3, $4, $5, now())`,
        [market.marketId, market.tenantId, count, amount, currencyCode],
      );
    await expect(insertRow('5', null)).rejects.toMatchObject({ code: CHECK });
    await expect(insertRow(null, currency)).rejects.toMatchObject({ code: CHECK });
    await expect(insertRow('-1', currency)).rejects.toMatchObject({ code: CHECK });
    await expect(insertRow(null, null, -1)).rejects.toMatchObject({ code: CHECK });
    await insertRow(null, null);
    await expect(
      app.query(`UPDATE reporting.daily_abandoned_carts SET cart_count = 9 WHERE market_id = $1`, [
        market.marketId,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(`DELETE FROM reporting.daily_abandoned_carts WHERE market_id = $1`, [
        market.marketId,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});
