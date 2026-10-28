import { money, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { PromotionsDependencies } from '../../src/modules/promotions/application/promotions-dependencies';
import { CreatePromotion } from '../../src/modules/promotions/application/use-cases/create-promotion.use-case';
import { GenerateBatchCodes } from '../../src/modules/promotions/application/use-cases/generate-batch-codes.use-case';
import { QuoteDiscounts } from '../../src/modules/promotions/application/use-cases/quote-discounts.use-case';
import { SetPromotionsStatus } from '../../src/modules/promotions/application/use-cases/set-promotions-status.use-case';
import { ViewBatchCodeSummary } from '../../src/modules/promotions/application/use-cases/view-batch-code-summary.use-case';
import { ConfigPromotionsPolicy } from '../../src/modules/promotions/infrastructure/config-promotions-policy';
import { CryptoBatchCodeCrypto } from '../../src/modules/promotions/infrastructure/crypto-batch-code-crypto';
import { PrismaBatchCodeRepository } from '../../src/modules/promotions/infrastructure/prisma-batch-code.repository';
import { PrismaMarketSettingRepository } from '../../src/modules/promotions/infrastructure/prisma-market-setting.repository';
import { PrismaOptInRepository } from '../../src/modules/promotions/infrastructure/prisma-opt-in.repository';
import { PrismaPromotionRepository } from '../../src/modules/promotions/infrastructure/prisma-promotion.repository';
import { PrismaReviewQueueRepository } from '../../src/modules/promotions/infrastructure/prisma-review-queue.repository';
import {
  PrismaFirstOrderSettingsRepository,
  PrismaShippingThresholdRepository,
} from '../../src/modules/promotions/infrastructure/prisma-settings.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import {
  FakeFlashSales,
  FakePriceHistory,
  FakeSellerActivity,
  FakeStepUp,
} from '../support/promotions-fakes';
import {
  TEST_CODE_PEPPER,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The phase 2 discount types on the real stores in both Market fixtures: the guards of the new
// columns and tables (parameters per type, flash window, tiers, bundle items, single-use codes),
// the repository round trip of tiers, bundle items and the flash terms, and the batch codes end to
// end (generate, quote, a used code is not applicable, codes of another Market are unknown).
// Rows are never deleted, so every test names its own ids and tolerates what earlier runs left.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const HASH = (n: number) => n.toString(16).padStart(64, '0');

describe.each(TEST_MARKETS)('promotions phase 2 types in market %s (database)', (code) => {
  const market = marketOf(code);
  const mk = market.marketId;
  const config = markets.get(market.marketId);
  const rules = config.promotions!;
  const policy = new ConfigPromotionsPolicy(markets);
  const currency = policy.settings(market)!.currency;
  const clock = new FixedClock(Temporal.Instant.from('2026-10-25T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'promo2-db-system-1');
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'promo2-db-admin-1',
  );
  const sellerId = ids.next<'Seller'>();

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let deps: PromotionsDependencies;
  let stepUp: FakeStepUp;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    stepUp = new FakeStepUp(() => clock.now());
    deps = {
      unitOfWork: db.unitOfWork,
      promotions: new PrismaPromotionRepository(db.service),
      optIns: new PrismaOptInRepository(db.service),
      reviews: new PrismaReviewQueueRepository(db.service),
      settings: new PrismaMarketSettingRepository(db.service),
      firstOrder: new PrismaFirstOrderSettingsRepository(db.service),
      thresholds: new PrismaShippingThresholdRepository(db.service),
      policy,
      batchCodes: new PrismaBatchCodeRepository(db.service),
      codeCrypto: new CryptoBatchCodeCrypto(TEST_CODE_PEPPER),
      flashSales: new FakeFlashSales(),
      sellerActivity: new FakeSellerActivity(),
      priceHistory: new FakePriceHistory(),
      stepUp,
      audit: { record: () => Promise.resolve() },
      ids,
      clock,
    };
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

  const state = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  const rows = async (text: string, values: unknown[] = []) =>
    (await owner.query(text, values)).rows as Record<string, unknown>[];
  const make = <U>(type: new (g: typeof gate, d: PromotionsDependencies) => U): U =>
    new type(gate, deps);

  const promotionSql = (overrides: Record<string, unknown> = {}): [string, unknown[]] => {
    const v = {
      id: ids.next<'Promotion'>(),
      market_id: mk,
      tenant_id: 'default',
      type: 'TIERED_CART',
      status: 'ACTIVE',
      name: 'Phase 2',
      funding: 'PLATFORM',
      platform_split_bps: null,
      owner_seller_id: null,
      combinable: true,
      code: null,
      starts_at: new Date('2026-10-01T00:00:00Z'),
      ends_at: null,
      test_mode: true,
      special_campaign: false,
      prior_approved: false,
      paused_by: null,
      currency: 'AUD',
      reward_kind: 'PERCENT',
      reward_bps: 500,
      reward_amount_minor: null,
      cap_minor: null,
      max_per_order_minor: null,
      max_total_uses: null,
      max_uses_per_customer: null,
      budget_minor: 100000,
      min_spend_minor: null,
      created_by_account_id: ids.next<'Account'>(),
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
    const keys = Object.keys(v);
    return [
      `INSERT INTO promotions.promotions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(v),
    ];
  };
  const attempt = (statement: [string, unknown[]], client: Client = sql) =>
    state(client.query(...statement));
  const seller = (overrides: Record<string, unknown> = {}) => ({
    funding: 'SELLER',
    owner_seller_id: sellerId,
    budget_minor: null,
    ...overrides,
  });

  describe('tables', () => {
    it('refuses a type or funding the domain cannot make', async () => {
      expect(
        await attempt(
          promotionSql({
            type: 'BATCH_CODE',
            reward_kind: 'FIXED',
            reward_bps: null,
            reward_amount_minor: 500,
          }),
        ),
      ).toBe('allowed');
      expect(await attempt(promotionSql({ type: 'NOPE' }))).toBe(CHECK);
      // Seller-funded types need seller funding, platform-funded types platform funding.
      for (const type of ['BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE']) {
        expect(await attempt(promotionSql({ type, funding: 'PLATFORM' }))).toBe(CHECK);
      }
      expect(
        await attempt(
          promotionSql({
            type: 'TIERED_CART',
            funding: 'SELLER',
            owner_seller_id: sellerId,
            budget_minor: null,
          }),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          promotionSql({
            type: 'BATCH_CODE',
            funding: 'SELLER',
            owner_seller_id: sellerId,
            budget_minor: null,
          }),
        ),
      ).toBe(CHECK);
      // A flash sale is either party's but never co-funded.
      const flash = {
        flash_unit_limit: 10,
        flash_time_zone: 'Australia/Brisbane',
        ends_at: new Date('2026-12-01T00:00:00Z'),
      };
      expect(await attempt(promotionSql({ type: 'FLASH_SALE', ...flash }))).toBe('allowed');
      expect(await attempt(promotionSql(seller({ type: 'FLASH_SALE', ...flash })))).toBe('allowed');
      expect(
        await attempt(
          promotionSql({
            type: 'FLASH_SALE',
            funding: 'CO_FUNDED',
            platform_split_bps: 4000,
            ...flash,
          }),
        ),
      ).toBe(CHECK);
    });

    it('holds the parameters of each type to that type', async () => {
      const bxgy = seller({ type: 'BUY_X_GET_Y', buy_qty: 2, get_qty: 1 });
      expect(await attempt(promotionSql(bxgy))).toBe('allowed');
      expect(await attempt(promotionSql({ ...bxgy, buy_qty: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...bxgy, get_qty: 0 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...bxgy, group_qty: 3 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...bxgy, max_repeats_per_order: 2 }))).toBe('allowed');
      expect(await attempt(promotionSql({ ...bxgy, max_repeats_per_order: 0 }))).toBe(CHECK);

      const multi = seller({
        type: 'MULTI_BUY',
        group_qty: 3,
        reward_kind: 'FIXED',
        reward_bps: null,
        reward_amount_minor: 2000,
      });
      expect(await attempt(promotionSql(multi))).toBe('allowed');
      expect(await attempt(promotionSql({ ...multi, group_qty: 1 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...multi, group_qty: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...multi, buy_qty: 1 }))).toBe(CHECK);
      expect(
        await attempt(
          promotionSql({
            ...multi,
            reward_kind: 'PERCENT',
            reward_bps: 500,
            reward_amount_minor: null,
          }),
        ),
      ).toBe(CHECK);

      const bundle = seller({
        type: 'BUNDLE',
        reward_kind: 'FIXED',
        reward_bps: null,
        reward_amount_minor: 900,
      });
      expect(await attempt(promotionSql(bundle))).toBe('allowed');
      expect(await attempt(promotionSql({ ...bundle, group_qty: 2 }))).toBe(CHECK);
      expect(
        await attempt(
          promotionSql({
            ...bundle,
            reward_kind: 'PERCENT',
            reward_bps: 500,
            reward_amount_minor: null,
          }),
        ),
      ).toBe(CHECK);

      // The quantities and repeats belong to their types alone.
      expect(await attempt(promotionSql({ buy_qty: 1 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ get_qty: 1 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ group_qty: 2 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ max_repeats_per_order: 1 }))).toBe(CHECK);
    });

    it('holds a flash sale to a limit, a zone and an end, and no other type to them', async () => {
      const flash = {
        type: 'FLASH_SALE',
        flash_unit_limit: 5,
        flash_time_zone: 'Australia/Brisbane',
        ends_at: new Date('2026-12-01T00:00:00Z'),
      };
      expect(await attempt(promotionSql(flash))).toBe('allowed');
      expect(await attempt(promotionSql({ ...flash, flash_unit_limit: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...flash, flash_unit_limit: 0 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...flash, flash_time_zone: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...flash, flash_time_zone: '' }))).toBe(CHECK);
      expect(await attempt(promotionSql({ ...flash, flash_time_zone: 'x'.repeat(65) }))).toBe(
        CHECK,
      );
      expect(await attempt(promotionSql({ ...flash, ends_at: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ flash_unit_limit: 5 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ flash_time_zone: 'Australia/Brisbane' }))).toBe(CHECK);
    });

    describe('tiers', () => {
      const tier = (promotionId: string, overrides: Record<string, unknown> = {}) => {
        const v = {
          market_id: mk,
          tenant_id: 'default',
          promotion_id: promotionId,
          threshold_minor: 5000,
          reward_kind: 'PERCENT',
          reward_bps: 500,
          reward_amount_minor: null,
          ...overrides,
        };
        const keys = Object.keys(v);
        return [
          `INSERT INTO promotions.promotion_tiers (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(v),
        ] as [string, unknown[]];
      };
      const parent = async () => {
        const statement = promotionSql();
        await sql.query(...statement);
        return statement[1][0] as string;
      };

      it('checks the reward and the threshold, keys a tier by its threshold and lets the application replace the set', async () => {
        const p = await parent();
        expect(await attempt(tier(p))).toBe('allowed');
        expect(await attempt(tier(p))).toBe(UNIQUE);
        expect(await attempt(tier(p, { threshold_minor: 0 }))).toBe(CHECK);
        expect(await attempt(tier(p, { threshold_minor: 9000, reward_bps: 0 }))).toBe(CHECK);
        expect(await attempt(tier(p, { threshold_minor: 9001, reward_bps: 10001 }))).toBe(CHECK);
        expect(await attempt(tier(p, { threshold_minor: 9002, reward_amount_minor: 100 }))).toBe(
          CHECK,
        );
        expect(
          await attempt(
            tier(p, {
              threshold_minor: 9003,
              reward_kind: 'FIXED',
              reward_bps: null,
              reward_amount_minor: 0,
            }),
          ),
        ).toBe(CHECK);
        expect(
          await attempt(
            tier(p, {
              threshold_minor: 9004,
              reward_kind: 'FIXED',
              reward_bps: 5,
              reward_amount_minor: 100,
            }),
          ),
        ).toBe(CHECK);
        expect(
          await attempt(
            tier(p, {
              threshold_minor: 9005,
              reward_kind: 'FIXED',
              reward_bps: null,
              reward_amount_minor: 100,
            }),
          ),
        ).toBe('allowed');
        expect(await attempt(tier(p, { threshold_minor: 9006, reward_kind: 'OTHER' }))).toBe(CHECK);
        expect(await attempt(tier(p, { threshold_minor: 9007, market_id: 'bad' }))).toBe(CHECK);
        expect(await attempt(tier(p, { threshold_minor: 9008, tenant_id: 'Bad Tenant' }))).toBe(
          CHECK,
        );
        expect(await attempt(tier(ids.next<'Promotion'>(), { threshold_minor: 9009 }))).toBe(
          FOREIGN_KEY,
        );

        // The application replaces the set (delete and insert) but never edits a row.
        expect(
          await state(
            sql.query(
              `UPDATE promotions.promotion_tiers SET reward_bps = 600 WHERE promotion_id = $1`,
              [p],
            ),
          ),
        ).toBe(NO_PRIVILEGE);
        expect(
          await state(
            sql.query(`DELETE FROM promotions.promotion_tiers WHERE promotion_id = $1`, [p]),
          ),
        ).toBe('allowed');
        expect(
          await rows(`SELECT 1 FROM promotions.promotion_tiers WHERE promotion_id = $1`, [p]),
        ).toEqual([]);
        // A promotion with tiers cannot be deleted from under them.
        await sql.query(...tier(p));
        expect(
          await state(owner.query(`DELETE FROM promotions.promotions WHERE id = $1`, [p])),
        ).toBe(RESTRICT);
      });
    });

    describe('bundle items', () => {
      it('checks the quantity and keys an item by its product', async () => {
        const statement = promotionSql(
          seller({
            type: 'BUNDLE',
            reward_kind: 'FIXED',
            reward_bps: null,
            reward_amount_minor: 900,
          }),
        );
        await sql.query(...statement);
        const p = statement[1][0] as string;
        const product = ids.next<'Product'>();
        const item = (productId: string, quantity: number): [string, unknown[]] => [
          `INSERT INTO promotions.promotion_bundle_items (market_id, tenant_id, promotion_id, product_id, quantity) VALUES ($1, 'default', $2, $3, $4)`,
          [mk, p, productId, quantity],
        ];
        expect(await attempt(item(product, 2))).toBe('allowed');
        expect(await attempt(item(product, 2))).toBe(UNIQUE);
        expect(await attempt(item(ids.next<'Product'>(), 0))).toBe(CHECK);
        expect(await attempt(item(ids.next<'Product'>(), 1001))).toBe(CHECK);
        expect(
          await state(
            sql.query(
              `UPDATE promotions.promotion_bundle_items SET quantity = 3 WHERE promotion_id = $1`,
              [p],
            ),
          ),
        ).toBe(NO_PRIVILEGE);
        expect(
          await state(
            sql.query(`DELETE FROM promotions.promotion_bundle_items WHERE promotion_id = $1`, [p]),
          ),
        ).toBe('allowed');
      });
    });

    describe('batch codes', () => {
      const insert = (
        promotionId: string,
        hash: string,
        overrides: Record<string, unknown> = {},
      ): [string, unknown[]] => {
        const v = {
          market_id: mk,
          tenant_id: 'default',
          code_hash: hash,
          promotion_id: promotionId,
          batch_id: ids.next<'PromotionBatch'>(),
          created_at: new Date('2026-10-25T10:00:00Z'),
          ...overrides,
        };
        const keys = Object.keys(v);
        return [
          `INSERT INTO promotions.promotion_batch_codes (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(v),
        ];
      };

      it('stores a hash only, once per Market, and is never changed or deleted by the application', async () => {
        const statement = promotionSql({
          type: 'BATCH_CODE',
          reward_kind: 'FIXED',
          reward_bps: null,
          reward_amount_minor: 500,
        });
        await sql.query(...statement);
        const p = statement[1][0] as string;
        const base = Date.now() % 1_000_000_000;
        const h = HASH(base * 10 + (code === 'AU' ? 1 : 2));
        expect(await attempt(insert(p, h))).toBe('allowed');
        expect(await attempt(insert(p, h))).toBe(UNIQUE);
        // A plain code or an upper-case hash is not a hash.
        expect(await attempt(insert(p, 'ABCDEFGH2345'))).toBe(CHECK);
        expect(
          await attempt(
            insert(
              p,
              HASH(base * 10 + 3)
                .toUpperCase()
                .replace(/^0+/, 'A'),
            ),
          ),
        ).toBe(CHECK);
        expect(
          await attempt(
            insert(p, HASH(base * 10 + 4), { used_at: new Date('2026-10-25T09:00:00Z') }),
          ),
        ).toBe(CHECK);
        expect(
          await attempt(
            insert(p, HASH(base * 10 + 5), { used_at: new Date('2026-10-25T11:00:00Z') }),
          ),
        ).toBe('allowed');
        expect(await attempt(insert(ids.next<'Promotion'>(), HASH(base * 10 + 6)))).toBe(
          FOREIGN_KEY,
        );
        expect(await attempt(insert(p, HASH(base * 10 + 7), { market_id: 'bad' }))).toBe(CHECK);
        expect(await attempt(insert(p, HASH(base * 10 + 8), { tenant_id: 'Bad Tenant' }))).toBe(
          CHECK,
        );

        expect(
          await state(
            sql.query(
              `UPDATE promotions.promotion_batch_codes SET used_at = now() WHERE code_hash = $1`,
              [h],
            ),
          ),
        ).toBe(NO_PRIVILEGE);
        expect(
          await state(
            sql.query(`DELETE FROM promotions.promotion_batch_codes WHERE code_hash = $1`, [h]),
          ),
        ).toBe(NO_PRIVILEGE);
        expect(
          await state(
            owner.query(`DELETE FROM promotions.promotion_batch_codes WHERE code_hash = $1`, [h]),
          ),
        ).toBe(RESTRICT);
        // The owner may mark a code used (the redemption of package T2 will do it).
        expect(
          await state(
            owner.query(
              `UPDATE promotions.promotion_batch_codes SET used_at = $2 WHERE code_hash = $1`,
              [h, new Date('2026-10-25T12:00:00Z')],
            ),
          ),
        ).toBe('allowed');
      });
    });
  });

  describe('use cases', () => {
    const startsAt = () => clock.now().subtract({ hours: 24 }).toString();
    const platform = (extra: Record<string, unknown>) => ({
      funding: 'PLATFORM',
      startsAt: startsAt(),
      budgetMinor: '100000',
      testMode: !rules.gstRulingConfirmed,
      ...extra,
    });
    const request = (code: string | null) => ({
      lines: [
        {
          id: 'l1',
          sellerId,
          productId: ids.next<'Product'>(),
          unitPrice: money(10000n, currency),
          quantity: 2,
        },
      ],
      shipping: [],
      code,
      isFirstOrder: false,
      testMode: !rules.gstRulingConfirmed,
      orderCommission: money(50000n, currency),
    });
    const on = () => make(SetPromotionsStatus).execute(admin, { status: 'active' });

    it('stores the tiers of a tiered cart discount and the flash terms, and reads them back', async () => {
      await on();
      const tiered = await make(CreatePromotion).execute(
        admin,
        platform({
          type: 'TIERED_CART',
          name: 'Spend more',
          tiers: [
            { thresholdMinor: '900000000', reward: { kind: 'FIXED', amountMinor: '500' } },
            { thresholdMinor: '1500000000', reward: { kind: 'FIXED', amountMinor: '2500' } },
          ],
        }),
      );
      expect(tiered.ok).toBe(true);
      if (!tiered.ok) return;
      const read = await db.unitOfWork.run(
        market,
        async () => ({
          ok: true as const,
          value: await deps.promotions.find(market, tiered.value.id),
        }),
        { readOnly: true },
      );
      const stored = read.ok ? read.value : null;
      expect(stored?.tiers?.map((t) => t.thresholdMinor)).toEqual([900000000n, 1500000000n]);

      const flash = await make(CreatePromotion).execute(
        admin,
        platform({
          type: 'FLASH_SALE',
          name: 'Flash',
          reward: { kind: 'PERCENT', bps: 1000 },
          productIds: [ids.next<'Product'>()],
          startsAt: undefined,
          flash: {
            unitLimit: 25,
            timeZone: 'Australia/Brisbane',
            startsLocal: '2026-10-26T18:00',
            endsLocal: '2026-10-26T21:00',
          },
        }),
      );
      expect(flash.ok).toBe(true);
      if (!flash.ok) return;
      const row = (
        await rows(
          `SELECT starts_at, ends_at, flash_unit_limit, flash_time_zone FROM promotions.promotions WHERE id = $1`,
          [flash.value.id],
        )
      )[0]!;
      expect(row.flash_unit_limit).toBe(25);
      expect(row.flash_time_zone).toBe('Australia/Brisbane');
      expect((row.starts_at as Date).toISOString()).toBe('2026-10-26T08:00:00.000Z');
      expect((row.ends_at as Date).toISOString()).toBe('2026-10-26T11:00:00.000Z');
    });

    // The reward is large and the commission wide so that no other platform promotion another spec
    // file leaves in the Market beats this one or exhausts the platform's share of the order.
    it('generates single-use codes, quotes one, and treats a used code and a code of another Market as not applicable', async () => {
      await on();
      const created = await make(CreatePromotion).execute(
        admin,
        platform({
          type: 'BATCH_CODE',
          name: 'Newsletter',
          reward: { kind: 'FIXED', amountMinor: '9000' },
        }),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const generated = await make(GenerateBatchCodes).execute(admin, {
        promotionId: created.value.id,
        count: 3,
      });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      expect(generated.value.codes).toHaveLength(3);
      const stored = await rows(
        `SELECT code_hash, used_at FROM promotions.promotion_batch_codes WHERE promotion_id = $1`,
        [created.value.id],
      );
      expect(stored).toHaveLength(3);
      // Only hashes are stored: no plain code appears in any column.
      for (const plain of generated.value.codes) {
        expect(JSON.stringify(stored)).not.toContain(plain);
      }
      const summary = await make(ViewBatchCodeSummary).execute(admin, {
        promotionId: created.value.id,
      });
      expect(summary.ok && summary.value.total).toBe(3);
      expect(summary.ok && summary.value.used).toBe(0);

      const [first, second] = generated.value.codes as [string, string];
      const applied = await make(QuoteDiscounts).execute(system, request(first));
      expect(applied).toEqual(expect.objectContaining({ ok: true }));
      expect(applied.ok && applied.value.code).toBe('APPLIED');
      expect(applied.ok && applied.value.applied.map((a) => a.promotionId)).toContain(
        created.value.id,
      );
      // A lower-case or spaced entry is the same code.
      const typed = await make(QuoteDiscounts).execute(system, request(` ${first.toLowerCase()} `));
      expect(typed.ok && typed.value.code).toBe('APPLIED');

      // The owner marks the code used (the redemption of package T2 does this).
      const hash = new CryptoBatchCodeCrypto(TEST_CODE_PEPPER).hash(first);
      await owner.query(
        `UPDATE promotions.promotion_batch_codes SET used_at = $2 WHERE market_id = $3 AND code_hash = $1`,
        [hash, clock.now().add({ minutes: 1 }).toString(), mk],
      );
      const used = await make(QuoteDiscounts).execute(system, request(first));
      expect(used.ok && used.value.code).toBe('NOT_APPLIED');
      expect(used.ok && used.value.applied.map((a) => a.promotionId)).not.toContain(
        created.value.id,
      );
      const other = await make(QuoteDiscounts).execute(system, request(second));
      expect(other.ok && other.value.code).toBe('APPLIED');
      const unknown = await make(QuoteDiscounts).execute(system, request('ZZZZZZZZZZZZ'));
      expect(unknown.ok && unknown.value.code).toBe('UNKNOWN');

      // The same hash in another Market is another row: the lookup is Market-scoped.
      const otherMarket = TEST_MARKETS.find((m) => m !== code)!;
      const foreignRows = await rows(
        `SELECT 1 FROM promotions.promotion_batch_codes WHERE market_id = $1 AND code_hash = $2`,
        [marketOf(otherMarket).marketId, hash],
      );
      expect(foreignRows).toEqual([]);
    });

    it('refuses to generate for a promotion that is not a batch-code promotion', async () => {
      await on();
      const created = await make(CreatePromotion).execute(
        admin,
        platform({
          type: 'TIERED_CART',
          name: 'Not a batch',
          tiers: [{ thresholdMinor: '900000000', reward: { kind: 'FIXED', amountMinor: '500' } }],
        }),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const refused = await make(GenerateBatchCodes).execute(admin, {
        promotionId: created.value.id,
        count: 1,
      });
      expect(refused.ok).toBe(false);
    });
  });
});
