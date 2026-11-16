import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { QuoteRequest } from '../../src/modules/promotions/contracts/promotions.facade';
import type { PromotionsDependencies } from '../../src/modules/promotions/application/promotions-dependencies';
import { CheckWasPrice } from '../../src/modules/promotions/application/use-cases/check-was-price.use-case';
import { ConfirmRedemptions } from '../../src/modules/promotions/application/use-cases/confirm-redemptions.use-case';
import { CreateOwnPromotion } from '../../src/modules/promotions/application/use-cases/create-own-promotion.use-case';
import { CreatePromotion } from '../../src/modules/promotions/application/use-cases/create-promotion.use-case';
import { GenerateBatchCodes } from '../../src/modules/promotions/application/use-cases/generate-batch-codes.use-case';
import { QuoteDiscounts } from '../../src/modules/promotions/application/use-cases/quote-discounts.use-case';
import { RedeemDiscounts } from '../../src/modules/promotions/application/use-cases/redeem-discounts.use-case';
import { ReleaseCancelledRedemptions } from '../../src/modules/promotions/application/use-cases/release-cancelled-redemptions.use-case';
import { SetPromotionsStatus } from '../../src/modules/promotions/application/use-cases/set-promotions-status.use-case';
import { summaryOf } from '../../src/modules/promotions/domain/redemption';
import { ConfigPromotionsPolicy } from '../../src/modules/promotions/infrastructure/config-promotions-policy';
import { CryptoBatchCodeCrypto } from '../../src/modules/promotions/infrastructure/crypto-batch-code-crypto';
import { PrismaBatchCodeRepository } from '../../src/modules/promotions/infrastructure/prisma-batch-code.repository';
import { PrismaCreditRepository } from '../../src/modules/promotions/infrastructure/prisma-credit.repository';
import { PrismaMarketSettingRepository } from '../../src/modules/promotions/infrastructure/prisma-market-setting.repository';
import { PrismaOptInRepository } from '../../src/modules/promotions/infrastructure/prisma-opt-in.repository';
import { PrismaPromotionRepository } from '../../src/modules/promotions/infrastructure/prisma-promotion.repository';
import { PrismaRedemptionRepository } from '../../src/modules/promotions/infrastructure/prisma-redemption.repository';
import { PrismaReferralRepository } from '../../src/modules/promotions/infrastructure/prisma-referral.repository';
import { PrismaReviewQueueRepository } from '../../src/modules/promotions/infrastructure/prisma-review-queue.repository';
import {
  PrismaFirstOrderSettingsRepository,
  PrismaShippingThresholdRepository,
} from '../../src/modules/promotions/infrastructure/prisma-settings.repository';
import { RedemptionFlashSales } from '../../src/modules/promotions/infrastructure/redemption-flash-sales';
import { PromotionsFacadeImplementation } from '../../src/modules/promotions/presentation/promotions.facade';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import type { HandledOnce, UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import {
  FakePriceHistory,
  FakeSellerActivity,
  FakeSellerCatalogue,
  FakeSellerCommission,
  FakeStepUp,
  phase3Fakes,
} from '../support/promotions-fakes';
import {
  TEST_CODE_PEPPER,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Package T2 on the real stores in both Market fixtures: two orders racing for one single-use code
// or the last units of a flash sale (one wins, the other gets the fresh quote and nothing is
// written for it), the usage counters and their release, and the database guards of the
// redemptions and the codes (only the allowed state changes, never a delete, for every role).
// Rows are never deleted, so every test makes its own promotions and orders.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';

describe.each(TEST_MARKETS)('promotions redemptions in market %s (database)', (code) => {
  const market = marketOf(code);
  const rules = markets.get(market.marketId).promotions!;
  const policy = new ConfigPromotionsPolicy(markets);
  const currency = policy.settings(market)!.currency;
  const clock = new FixedClock(Temporal.Instant.from('2026-10-25T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'redeem-db-system-1');
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'redeem-db-admin-1',
  );
  const sellerId = ids.next<'Seller'>();
  const seller = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId,
    }),
    'redeem-db-seller-1',
  );

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let deps: PromotionsDependencies;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    const activity = new FakeSellerActivity();
    activity.since.set(sellerId, clock.now().subtract({ hours: 24 * 400 }));
    const redemptions = new PrismaRedemptionRepository(db.service);
    // The dispatcher's inbox in memory (the delivery is not one it handed out); the work runs in
    // a real unit.
    const inbox = new Set<string>();
    const unitOfWork: UnitOfWork = {
      run: (...args) => db.unitOfWork.run(...args),
      runOnce: async <T, E>(
        m: Parameters<UnitOfWork['runOnce']>[0],
        d: EventDelivery,
        work: () => Promise<Result<T, E>>,
        options?: Parameters<UnitOfWork['runOnce']>[3],
      ): Promise<Result<HandledOnce<T>, E>> => {
        const key = `${m.marketId}|${d.eventId}|${d.subscriber}`;
        if (inbox.has(key)) return ok({ handled: false });
        const done = await db.unitOfWork.run(m, work, options);
        if (!done.ok) return done;
        inbox.add(key);
        return ok({ handled: true, value: done.value });
      },
    };
    deps = {
      unitOfWork,
      promotions: new PrismaPromotionRepository(db.service),
      optIns: new PrismaOptInRepository(db.service),
      reviews: new PrismaReviewQueueRepository(db.service),
      settings: new PrismaMarketSettingRepository(db.service),
      firstOrder: new PrismaFirstOrderSettingsRepository(db.service),
      thresholds: new PrismaShippingThresholdRepository(db.service),
      policy,
      batchCodes: new PrismaBatchCodeRepository(db.service),
      codeCrypto: new CryptoBatchCodeCrypto(TEST_CODE_PEPPER),
      flashSales: new RedemptionFlashSales(db.unitOfWork, redemptions),
      sellerActivity: activity,
      priceHistory: new FakePriceHistory(),
      sellerCommission: new FakeSellerCommission(),
      sellerCatalogue: new FakeSellerCatalogue(),
      ...phase3Fakes(),
      credits: new PrismaCreditRepository(db.service),
      referrals: new PrismaReferralRepository(db.service),
      redemptions,
      stepUp: new FakeStepUp(() => clock.now()),
      audit: { record: () => Promise.resolve() },
      ids,
      clock,
    };
    const on = await make(SetPromotionsStatus).execute(admin, { status: 'active' });
    expect(on.ok).toBe(true);
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

  const make = <U>(type: new (g: typeof gate, d: PromotionsDependencies) => U): U =>
    new type(gate, deps);
  const facade = () =>
    new PromotionsFacadeImplementation(
      make(QuoteDiscounts),
      make(RedeemDiscounts),
      make(CheckWasPrice),
    );
  const state = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  const rows = async (text: string, values: unknown[] = []) =>
    (await owner.query(text, values)).rows as Record<string, unknown>[];
  const delivery = (): EventDelivery => ({
    eventId: ids.next<'event'>(),
    subscriber: 'promotions.test',
    attempt: 1,
  });
  const startsAt = () => clock.now().subtract({ hours: 24 }).toString();
  const created = async (
    result: Promise<{ ok: true; value: { id: Id<'Promotion'> } } | { ok: false; error: unknown }>,
  ) => {
    const r = await result;
    if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
    return r.value;
  };
  const request = (
    productId: Id<'Product'>,
    unitPrice: bigint,
    quantity: number,
    extra: Partial<QuoteRequest> = {},
  ): QuoteRequest => ({
    lines: [{ id: 'l1', sellerId, productId, unitPrice: money(unitPrice, currency), quantity }],
    shipping: [],
    code: null,
    isFirstOrder: false,
    customerAccountId: null,
    testMode: true,
    orderCommission: money(1_000_000n, currency),
    ...extra,
  });
  /** Quotes for a new order and returns its redemption, to be run later (or in parallel). */
  const pricedOrder = async (req: QuoteRequest) => {
    const orderId = ids.next<'Order'>();
    const customerAccountId = ids.next<'Account'>();
    const withCustomer = { ...req, customerAccountId };
    const quoted = await facade().quote(system, withCustomer);
    if (!quoted.ok) throw new Error('quote failed');
    return {
      orderId,
      quoted: quoted.value,
      redeem: () =>
        facade().redeem(system, {
          orderId,
          customerAccountId,
          request: withCustomer,
          expected: summaryOf(quoted.value),
        }),
    };
  };
  const usage = async (promotionId: string) =>
    (
      await rows(
        `SELECT uses_count, spent_minor::text AS spent FROM promotions.promotion_usage
          WHERE market_id = $1 AND promotion_id = $2`,
        [market.marketId, promotionId],
      )
    )[0];

  it('lets exactly one of two racing orders take a single-use code', async () => {
    const p = await created(
      make(CreatePromotion).execute(admin, {
        type: 'BATCH_CODE',
        name: 'Race',
        funding: 'PLATFORM',
        startsAt: startsAt(),
        budgetMinor: '100000',
        testMode: !rules.gstRulingConfirmed,
        reward: { kind: 'FIXED', amountMinor: '500' },
      }),
    );
    const generated = await make(GenerateBatchCodes).execute(admin, {
      promotionId: p.id,
      count: 1,
    });
    if (!generated.ok) throw new Error('generate failed');
    const [only] = generated.value.codes;
    const productId = ids.next<'Product'>();
    const a = await pricedOrder(request(productId, 5000n, 1, { code: only! }));
    const b = await pricedOrder(request(productId, 5000n, 1, { code: only! }));
    expect(a.quoted.code).toBe('APPLIED');
    expect(b.quoted.code).toBe('APPLIED');

    const results = await Promise.all([a.redeem(), b.redeem()]);
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ ok: false, error: { code: 'promotions.quote-changed' } });
    const hash = deps.codeCrypto.hash(only!);
    const code = await rows(
      `SELECT redeemed_order_id, used_at FROM promotions.promotion_batch_codes
        WHERE market_id = $1 AND code_hash = $2`,
      [market.marketId, hash],
    );
    const winner = results[0].ok ? a.orderId : b.orderId;
    expect(code[0]).toMatchObject({ redeemed_order_id: winner });
    expect(await usage(p.id)).toEqual({ uses_count: 1, spent: '500' });

    // The winner is cancelled: the code and the counters come back.
    const released = await make(ReleaseCancelledRedemptions).execute(system, {
      delivery: delivery(),
      orderId: winner,
    });
    expect(released).toEqual({ ok: true, value: { outcome: 'released' } });
    const after = await rows(
      `SELECT redeemed_order_id, used_at FROM promotions.promotion_batch_codes
        WHERE market_id = $1 AND code_hash = $2`,
      [market.marketId, hash],
    );
    expect(after[0]).toEqual({ redeemed_order_id: null, used_at: null });
    expect(await usage(p.id)).toEqual({ uses_count: 0, spent: '0' });
  });

  it('never sells more units of a flash sale than its limit, however orders race', async () => {
    const productId = ids.next<'Product'>();
    const sale = await created(
      make(CreateOwnPromotion).execute(seller, {
        type: 'FLASH_SALE',
        name: 'Last three',
        funding: 'SELLER',
        reward: { kind: 'PERCENT', bps: 3000 },
        productIds: [productId],
        startsAt: startsAt(),
        endsAt: clock.now().add({ hours: 24 }).toString(),
        flash: { unitLimit: 3, timeZone: 'Australia/Brisbane' },
      }),
    );
    const orders = await Promise.all(
      [0, 1, 2].map(() => pricedOrder(request(productId, 1000n, 2, { testMode: false }))),
    );
    for (const o of orders) expect(o.quoted.totals.goodsDiscount).toBe(600n);
    const results = await Promise.all(orders.map((o) => o.redeem()));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const sold = await rows(
      `SELECT COALESCE(SUM(units), 0)::int AS units FROM promotions.redemptions
        WHERE market_id = $1 AND promotion_id = $2 AND status <> 'RELEASED'`,
      [market.marketId, sale.id],
    );
    expect(sold[0]).toEqual({ units: 2 });
    // One unit is left for the next order.
    const next = await pricedOrder(request(productId, 1000n, 2, { testMode: false }));
    expect(next.quoted.totals.goodsDiscount).toBe(300n);
  });

  it('confirms on payment and keeps the guards of the rows', async () => {
    const productId = ids.next<'Product'>();
    await created(
      make(CreateOwnPromotion).execute(seller, {
        type: 'SELLER_SALE',
        name: 'Guards',
        funding: 'SELLER',
        startsAt: startsAt(),
        reward: { kind: 'PERCENT', bps: 1000 },
        productIds: [productId],
      }),
    );
    const o = await pricedOrder(request(productId, 5000n, 1, { testMode: false }));
    expect(await o.redeem()).toEqual({ ok: true, value: { outcome: 'redeemed' } });
    const paid = await make(ConfirmRedemptions).execute(system, {
      delivery: delivery(),
      orderId: o.orderId,
    });
    expect(paid).toEqual({ ok: true, value: { outcome: 'confirmed' } });
    const [row] = await rows(
      `SELECT id, status FROM promotions.redemptions WHERE market_id = $1 AND order_id = $2`,
      [market.marketId, o.orderId],
    );
    expect(row).toMatchObject({ status: 'CONFIRMED' });

    // Back to RESERVED, a changed amount, a delete: refused for the app and the owner alike.
    for (const client of [sql, owner]) {
      expect(
        await state(
          client.query(
            `UPDATE promotions.redemptions SET status = 'RESERVED', confirmed_at = NULL WHERE id = $1`,
            [row!.id],
          ),
        ),
      ).toBe(RESTRICT);
    }
    expect(
      await state(
        owner.query(
          `UPDATE promotions.redemptions SET amount_minor = amount_minor + 1,
             seller_share_minor = seller_share_minor + 1 WHERE id = $1`,
          [row!.id],
        ),
      ),
    ).toBe(RESTRICT);
    expect(
      await state(sql.query(`DELETE FROM promotions.redemptions WHERE id = $1`, [row!.id])),
    ).toBe(NO_PRIVILEGE);
    expect(
      await state(owner.query(`DELETE FROM promotions.redemptions WHERE id = $1`, [row!.id])),
    ).toBe(RESTRICT);
    // The app may not change a column outside the state change.
    expect(
      await state(
        sql.query(`UPDATE promotions.redemptions SET amount_minor = 1 WHERE id = $1`, [row!.id]),
      ),
    ).toBe(NO_PRIVILEGE);
    // One row per order and promotion.
    expect(
      await state(
        owner.query(
          `INSERT INTO promotions.redemptions
             SELECT gen_random_uuid(), market_id, tenant_id, order_id, promotion_key, promotion_id, kind,
                    customer_account_id, code_hash, currency, amount_minor, seller_share_minor,
                    platform_share_minor, units, budget_month, 'RESERVED', NULL, reserved_at, NULL, NULL
               FROM promotions.redemptions WHERE id = $1`,
          [row!.id],
        ),
      ),
    ).toBe(UNIQUE);
    // The split adds up; a first-order row names its month; a stored promotion's key is its id.
    expect(
      await state(
        owner.query(
          `UPDATE promotions.redemptions SET status = 'RELEASED', released_at = reserved_at,
             release_reason = 'SOMETHING' WHERE id = $1`,
          [row!.id],
        ),
      ),
    ).toBe(CHECK);
  });

  it('keeps a single-use code to one order at a time in the database too', async () => {
    const p = await created(
      make(CreatePromotion).execute(admin, {
        type: 'BATCH_CODE',
        name: 'Guard',
        funding: 'PLATFORM',
        startsAt: startsAt(),
        budgetMinor: '100000',
        testMode: !rules.gstRulingConfirmed,
        reward: { kind: 'FIXED', amountMinor: '500' },
      }),
    );
    const generated = await make(GenerateBatchCodes).execute(admin, {
      promotionId: p.id,
      count: 1,
    });
    if (!generated.ok) throw new Error('generate failed');
    const hash = deps.codeCrypto.hash(generated.value.codes[0]!);
    // A use without the order (or the order without the use) is refused.
    expect(
      await state(
        sql.query(
          `UPDATE promotions.promotion_batch_codes SET used_at = now() WHERE market_id = $1 AND code_hash = $2`,
          [market.marketId, hash],
        ),
      ),
    ).toBe(CHECK);
    expect(
      await state(
        sql.query(
          `UPDATE promotions.promotion_batch_codes SET used_at = now(), redeemed_order_id = $3
            WHERE market_id = $1 AND code_hash = $2`,
          [market.marketId, hash, ids.next<'Order'>()],
        ),
      ),
    ).toBe('allowed');
    // Moving a used code straight to another order is refused (it must be given back first).
    expect(
      await state(
        sql.query(
          `UPDATE promotions.promotion_batch_codes SET redeemed_order_id = $3
            WHERE market_id = $1 AND code_hash = $2`,
          [market.marketId, hash, ids.next<'Order'>()],
        ),
      ),
    ).toBe(RESTRICT);
    // The usage counters never go below zero.
    expect(
      await state(
        sql.query(
          `UPDATE promotions.promotion_usage SET uses_count = uses_count - 1
            WHERE market_id = $1 AND promotion_id = $2`,
          [market.marketId, p.id],
        ),
      ),
    ).toBe(CHECK);
  });
});
