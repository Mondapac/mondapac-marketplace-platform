import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { PromotionsDependencies } from '../../src/modules/promotions/application/promotions-dependencies';
import { CreateOwnPromotion } from '../../src/modules/promotions/application/use-cases/create-own-promotion.use-case';
import { CreatePromotion } from '../../src/modules/promotions/application/use-cases/create-promotion.use-case';
import { DecidePromotionReview } from '../../src/modules/promotions/application/use-cases/decide-promotion-review.use-case';
import { EditOwnPromotion } from '../../src/modules/promotions/application/use-cases/edit-own-promotion.use-case';
import { EditPromotion } from '../../src/modules/promotions/application/use-cases/edit-promotion.use-case';
import { ListPromotionReviews } from '../../src/modules/promotions/application/use-cases/list-promotion-reviews.use-case';
import { PauseOwnPromotion } from '../../src/modules/promotions/application/use-cases/pause-own-promotion.use-case';
import { PausePromotion } from '../../src/modules/promotions/application/use-cases/pause-promotion.use-case';
import { QuoteDiscounts } from '../../src/modules/promotions/application/use-cases/quote-discounts.use-case';
import { SetCoFundingOptIn } from '../../src/modules/promotions/application/use-cases/set-co-funding-opt-in.use-case';
import { SetFreeShippingThreshold } from '../../src/modules/promotions/application/use-cases/set-free-shipping-threshold.use-case';
import { SetPromotionBudget } from '../../src/modules/promotions/application/use-cases/set-promotion-budget.use-case';
import { SetPromotionsStatus } from '../../src/modules/promotions/application/use-cases/set-promotions-status.use-case';
import { ViewPromotionsSettings } from '../../src/modules/promotions/application/use-cases/view-promotions-settings.use-case';
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
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Promotions as the application role in both Market fixtures: the tables' own guards (the unique
// keys, the CHECKs, never-deleted rows, column-level grants, no key to another schema) and the use
// cases on the real stores: the switch, a create, the one-code-per-Market guarantee under two
// parallel creates, the review queue and a quote through the stored promotions. Rows are never
// deleted, so every test names its own ids and codes and tolerates what earlier runs left.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const TABLES = [
  'promotions',
  'promotion_targets',
  'promotion_usage',
  'co_funding_opt_ins',
  'promotion_reviews',
  'first_order_settings',
  'free_shipping_thresholds',
  'market_settings',
  'promotion_tiers',
  'promotion_bundle_items',
  'promotion_batch_codes',
] as const;

/**
 * The state of a TRUNCATE ... CASCADE. TRUNCATE takes exclusive locks on every table it reaches, so
 * while another spec file uses the same tables it can lose a deadlock (40P01) or time out (55P03);
 * the statement is then asked again, until the trigger's RESTRICT answers.
 */
async function truncateState(client: Client, table: string): Promise<string | undefined> {
  let last: string | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    last = await client.query(`TRUNCATE promotions.${table} CASCADE`).then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
    if (last !== '40P01' && last !== '55P03') return last;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return last;
}

describe.each(TEST_MARKETS)('promotions in market %s (database)', (code) => {
  const market = marketOf(code);
  const mk = market.marketId;
  const config = markets.get(market.marketId);
  const rules = config.promotions!;
  const policy = new ConfigPromotionsPolicy(markets);
  const currency = policy.settings(market)!.currency;
  const clock = new FixedClock(Temporal.Instant.from('2026-10-25T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'promo-db-system-1');
  const adminAccount = ids.next<'Account'>();
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: adminAccount,
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'promo-db-admin-1',
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
    'promo-db-seller-1',
  );
  const run = Date.now().toString(36).toUpperCase();

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let deps: PromotionsDependencies;
  let activity: FakeSellerActivity;
  let stepUp: FakeStepUp;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    activity = new FakeSellerActivity();
    activity.since.set(sellerId, clock.now().subtract({ hours: 24 * 400 }));
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
      codeCrypto: new CryptoBatchCodeCrypto(),
      flashSales: new FakeFlashSales(),
      sellerActivity: activity,
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

  // ---- the tables' own guards ---------------------------------------------------------------

  describe('tables', () => {
    const promotionSql = (overrides: Record<string, unknown> = {}): [string, unknown[]] => {
      const v = {
        id: ids.next<'Promotion'>(),
        market_id: mk,
        tenant_id: 'default',
        type: 'CART_DISCOUNT',
        status: 'ACTIVE',
        name: 'Platform cart',
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

    it('every table carries market_id and tenant_id, and none has a key to another schema', async () => {
      const columns = await rows(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'promotions' AND column_name IN ('market_id', 'tenant_id')`,
      );
      for (const table of TABLES) {
        const own = columns.filter((c) => c.table_name === table).map((c) => c.column_name);
        expect(own.sort()).toEqual(['market_id', 'tenant_id']);
      }
      const foreign = await rows(
        `SELECT c.conname FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
           JOIN pg_class t ON t.oid = c.confrelid
           JOIN pg_namespace tn ON tn.oid = t.relnamespace
          WHERE c.contype = 'f' AND n.nspname = 'promotions' AND tn.nspname <> 'promotions'`,
      );
      expect(foreign).toEqual([]);
    });

    it('accepts the shapes the domain makes and refuses the ones it must not', async () => {
      const seller = ids.next<'Seller'>();
      expect(await attempt(promotionSql())).toBe('allowed');
      expect(
        await attempt(
          promotionSql({
            type: 'SELLER_SALE',
            funding: 'SELLER',
            owner_seller_id: seller,
            budget_minor: null,
          }),
        ),
      ).toBe('allowed');
      // A platform promotion has a budget; a seller promotion has an owner; a split exists only
      // for a co-funded one.
      expect(await attempt(promotionSql({ budget_minor: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ owner_seller_id: seller }))).toBe(CHECK);
      expect(
        await attempt(promotionSql({ type: 'SELLER_SALE', funding: 'SELLER', budget_minor: null })),
      ).toBe(CHECK);
      expect(await attempt(promotionSql({ platform_split_bps: 5000 }))).toBe(CHECK);
      expect(
        await attempt(
          promotionSql({ type: 'CO_FUNDED_CAMPAIGN', funding: 'CO_FUNDED', platform_split_bps: 0 }),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          promotionSql({
            type: 'CO_FUNDED_CAMPAIGN',
            funding: 'CO_FUNDED',
            platform_split_bps: 4000,
          }),
        ),
      ).toBe('allowed');
      // The code belongs to the code type alone and has a fixed shape.
      expect(await attempt(promotionSql({ code: `ABCD${run}` }))).toBe(CHECK);
      expect(await attempt(promotionSql({ type: 'CART_CODE', code: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ type: 'CART_CODE', code: 'lower' }))).toBe(CHECK);
      // Rewards, schedule, status, owner-only states, special campaigns, pauses.
      expect(await attempt(promotionSql({ reward_bps: 0 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ reward_bps: null }))).toBe(CHECK);
      expect(await attempt(promotionSql({ reward_bps: 10001 }))).toBe(CHECK);
      expect(
        await attempt(
          promotionSql({ reward_kind: 'FIXED', reward_bps: null, reward_amount_minor: 0 }),
        ),
      ).toBe(CHECK);
      expect(await attempt(promotionSql({ reward_kind: 'FIXED', reward_amount_minor: 100 }))).toBe(
        CHECK,
      );
      expect(await attempt(promotionSql({ ends_at: new Date('2026-09-01T00:00:00Z') }))).toBe(
        CHECK,
      );
      expect(await attempt(promotionSql({ status: 'DELETED' }))).toBe(CHECK);
      expect(await attempt(promotionSql({ status: 'PENDING_APPROVAL' }))).toBe(CHECK);
      expect(await attempt(promotionSql({ status: 'PAUSED' }))).toBe(CHECK);
      expect(await attempt(promotionSql({ status: 'PAUSED', paused_by: 'ADMIN' }))).toBe('allowed');
      expect(await attempt(promotionSql({ paused_by: 'ADMIN' }))).toBe(CHECK);
      expect(
        await attempt(
          promotionSql({
            type: 'SELLER_SALE',
            funding: 'SELLER',
            owner_seller_id: seller,
            budget_minor: null,
            special_campaign: true,
          }),
        ),
      ).toBe(CHECK);
      expect(await attempt(promotionSql({ name: '' }))).toBe(CHECK);
      expect(await attempt(promotionSql({ name: 'x'.repeat(121) }))).toBe(CHECK);
      expect(await attempt(promotionSql({ market_id: 'bad' }))).toBe(CHECK);
      expect(await attempt(promotionSql({ tenant_id: 'Bad Tenant' }))).toBe(CHECK);
      expect(await attempt(promotionSql({ cap_minor: 0 }))).toBe(CHECK);
      expect(await attempt(promotionSql({ min_spend_minor: -1 }))).toBe(CHECK);
    });

    it('keeps a code unique inside a Market', async () => {
      const codeText = `CODE-${run}-U`;
      const base = { type: 'CART_CODE', code: codeText };
      expect(await attempt(promotionSql(base))).toBe('allowed');
      expect(await attempt(promotionSql(base))).toBe(UNIQUE);
    });

    it('never deletes a promotion, and lets the application change only the granted columns', async () => {
      const statement = promotionSql();
      await sql.query(...statement);
      const promotionId = statement[1][0];
      expect(
        await state(sql.query(`DELETE FROM promotions.promotions WHERE id = $1`, [promotionId])),
      ).toBe(NO_PRIVILEGE);
      expect(
        await state(owner.query(`DELETE FROM promotions.promotions WHERE id = $1`, [promotionId])),
      ).toBe(RESTRICT);
      for (const table of TABLES.filter(
        (t) =>
          ![
            'promotion_targets',
            'free_shipping_thresholds',
            'promotion_tiers',
            'promotion_bundle_items',
          ].includes(t),
      )) {
        expect(await truncateState(owner, table)).toBe(RESTRICT);
      }
      expect(
        await state(
          sql.query(
            `UPDATE promotions.promotions SET status = 'PAUSED', paused_by = 'ADMIN' WHERE id = $1`,
            [promotionId],
          ),
        ),
      ).toBe('allowed');
      // What a promotion is never changes, and neither do its Market, tenant and id.
      for (const column of [
        'market_id',
        'tenant_id',
        'id',
        'type',
        'funding',
        'owner_seller_id',
        'code',
        'currency',
        'created_by_account_id',
        'created_at',
      ]) {
        expect(
          await state(
            sql.query(`UPDATE promotions.promotions SET ${column} = ${column} WHERE id = $1`, [
              promotionId,
            ]),
          ),
        ).toBe(NO_PRIVILEGE);
      }
    });

    it('keeps usage insert-only for the application, with shares that add up', async () => {
      const statement = promotionSql();
      await sql.query(...statement);
      const promotionId = statement[1][0];
      const usage = (spent: number, seller: number, platform: number) =>
        state(
          sql.query(
            `INSERT INTO promotions.promotion_usage (market_id, tenant_id, promotion_id, uses_count, spent_minor, seller_share_minor, platform_share_minor, updated_at)
             VALUES ($1, 'default', $2, 0, $3, $4, $5, now())`,
            [mk, promotionId, spent, seller, platform],
          ),
        );
      expect(await usage(100, 30, 60)).toBe(CHECK);
      expect(await usage(100, 30, 70)).toBe('allowed');
      expect(await usage(0, 0, 0)).toBe(UNIQUE);
      expect(
        await state(
          sql.query(
            `UPDATE promotions.promotion_usage SET uses_count = 1 WHERE promotion_id = $1`,
            [promotionId],
          ),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await state(
          owner.query(`DELETE FROM promotions.promotion_usage WHERE promotion_id = $1`, [
            promotionId,
          ]),
        ),
      ).toBe(RESTRICT);
    });

    it('refuses a child row of a promotion that does not exist, or of another Market', async () => {
      expect(
        await state(
          sql.query(
            `INSERT INTO promotions.promotion_targets (market_id, tenant_id, promotion_id, kind, value)
             VALUES ($1, 'default', $2, 'ZONE', 'city')`,
            [mk, ids.next()],
          ),
        ),
      ).toBe(FOREIGN_KEY);
      const statement = promotionSql();
      await sql.query(...statement);
      const target = (kind: string, value: string, market: string = mk) =>
        state(
          sql.query(
            `INSERT INTO promotions.promotion_targets (market_id, tenant_id, promotion_id, kind, value)
             VALUES ($1, 'default', $2, $3, $4)`,
            [market, statement[1][0], kind, value],
          ),
        );
      expect(await target('ZONE', 'city')).toBe('allowed');
      expect(await target('ZONE', 'city')).toBe(UNIQUE);
      expect(await target('ZONE', 'bad value!')).toBe(CHECK);
      expect(await target('PRODUCT', 'not-a-uuid')).toBe(CHECK);
      expect(await target('PRODUCT', ids.next())).toBe('allowed');
      expect(await target('ZONE', 'other', mk === 'TAU' ? 'TZZ' : 'TAU')).toBe(FOREIGN_KEY);
      // The target list is replaced as a set, so the application may delete from it.
      expect(
        await state(
          sql.query(`DELETE FROM promotions.promotion_targets WHERE promotion_id = $1`, [
            statement[1][0],
          ]),
        ),
      ).toBe('allowed');
    });

    it('allows one open review per promotion, and a decision with its time and decider', async () => {
      const statement = promotionSql({
        type: 'SELLER_SALE',
        funding: 'SELLER',
        owner_seller_id: ids.next<'Seller'>(),
        budget_minor: null,
      });
      await sql.query(...statement);
      const review = (status = 'OPEN', decidedAt: Date | null = null, by: string | null = null) =>
        state(
          sql.query(
            `INSERT INTO promotions.promotion_reviews (id, market_id, tenant_id, promotion_id, seller_id, reason, status, opened_at, decided_at, decided_by_account_id)
             VALUES ($1, $2, 'default', $3, $4, 'NEW_SELLER', $5, now(), $6, $7)`,
            [ids.next(), mk, statement[1][0], ids.next(), status, decidedAt, by],
          ),
        );
      expect(await review()).toBe('allowed');
      expect(await review()).toBe(UNIQUE);
      expect(await review('APPROVED')).toBe(CHECK);
      expect(await review('APPROVED', new Date(), ids.next())).toBe('allowed');
      expect(await review('OPEN', new Date(), ids.next())).toBe(CHECK);
      expect(await review('MAYBE')).toBe(CHECK);
    });

    it('keeps the thresholds per zone and the switch to its two states', async () => {
      const threshold = (zone: string, amount: number) =>
        state(
          sql.query(
            `INSERT INTO promotions.free_shipping_thresholds (id, market_id, tenant_id, zone_code, threshold_minor, updated_at, updated_by_account_id)
             VALUES ($1, $2, 'default', $3, $4, now(), $5)`,
            [ids.next(), mk, zone, amount, ids.next()],
          ),
        );
      const zone = `z-${run}`;
      expect(await threshold(zone, 5000)).toBe('allowed');
      expect(await threshold(zone, 6000)).toBe(UNIQUE);
      expect(await threshold('bad zone', 1)).toBe(CHECK);
      expect(await threshold(`y-${run}`, -1)).toBe(CHECK);
      // A threshold of zero would make shipping free at any spend.
      expect(await threshold(`w-${run}`, 0)).toBe(CHECK);
      // A zone may return to the Market default, so its row may go.
      expect(
        await state(
          sql.query(`DELETE FROM promotions.free_shipping_thresholds WHERE zone_code = $1`, [zone]),
        ),
      ).toBe('allowed');
      const setting = (status: string) =>
        state(
          owner.query(
            `INSERT INTO promotions.market_settings (market_id, tenant_id, status, updated_at, updated_by_account_id)
             VALUES ($1, 'default', $2, now(), $3)`,
            [`Q${run}`.slice(0, 8), status, ids.next()],
          ),
        );
      expect(await setting('paused')).toBe(CHECK);
    });

    it('refuses a first-order setting that does not match its kind', async () => {
      const setting = (extra: Record<string, unknown>) => {
        const v = {
          market_id: `X${run}`.slice(0, 8),
          tenant_id: 'default',
          enabled: true,
          kind: 'FIXED',
          percent_bps: null,
          amount_minor: 800,
          cap_minor: null,
          min_spend_minor: 0,
          monthly_budget_minor: 0,
          updated_at: new Date(),
          updated_by_account_id: ids.next(),
          ...extra,
        };
        const keys = Object.keys(v);
        return state(
          owner.query(
            `INSERT INTO promotions.first_order_settings (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
            Object.values(v),
          ),
        );
      };
      expect(await setting({ amount_minor: null })).toBe(CHECK);
      expect(await setting({ percent_bps: 500 })).toBe(CHECK);
      expect(await setting({ kind: 'PERCENT', percent_bps: 0, amount_minor: null })).toBe(CHECK);
      expect(await setting({ min_spend_minor: -1 })).toBe(CHECK);
    });
  });

  // ---- the use cases on the real stores -----------------------------------------------------

  describe('use cases', () => {
    const platformCart = (extra: Record<string, unknown> = {}) => ({
      type: 'CART_DISCOUNT',
      name: 'Platform cart',
      funding: 'PLATFORM',
      startsAt: clock.now().subtract({ hours: 24 }).toString(),
      reward: { kind: 'PERCENT', bps: 500 },
      budgetMinor: '100000',
      testMode: true,
      ...extra,
    });
    const request = (productId: Id<'Product'>, extra: Record<string, unknown> = {}) => ({
      lines: [
        {
          id: 'l1',
          sellerId,
          productId,
          unitPrice: money(10000n, currency),
          quantity: 2,
        },
      ],
      shipping: [],
      code: null,
      isFirstOrder: false,
      testMode: true,
      orderCommission: money(5000n, currency),
      ...extra,
    });

    it('is off until an admin turns it on, and then takes a promotion and quotes it', async () => {
      // Whatever an earlier run left, the switch is on from here.
      expect((await make(SetPromotionsStatus).execute(admin, { status: 'active' })).ok).toBe(true);
      const settings = await make(ViewPromotionsSettings).execute(admin, {});
      expect(settings.ok && settings.value.status).toBe('active');

      const created = await make(CreatePromotion).execute(admin, platformCart());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const quoted = await make(QuoteDiscounts).execute(system, request(ids.next<'Product'>()));
      expect(quoted.ok).toBe(true);
      if (!quoted.ok) return;
      expect(quoted.value.enabled).toBe(true);
      expect(quoted.value.applied.map((a) => a.promotionId)).toContain(created.value.id);
      expect(quoted.value.totals.goodsGross).toBe(20000n);

      // Paused promotions stop applying at once; a real order never sees test-mode money.
      await make(PausePromotion).execute(admin, { promotionId: created.value.id });
      const after = await make(QuoteDiscounts).execute(system, request(ids.next<'Product'>()));
      expect(after.ok && after.value.applied.map((a) => a.promotionId)).not.toContain(
        created.value.id,
      );
      const real = await make(QuoteDiscounts).execute(
        system,
        request(ids.next<'Product'>(), { testMode: false }),
      );
      expect(real.ok && real.value.applied.map((a) => a.promotionId)).not.toContain(
        created.value.id,
      );
    });

    it('lets only one of two parallel creates take a code', async () => {
      await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      const body = platformCart({ type: 'CART_CODE', code: `RACE-${run}`, name: 'Race' });
      const results = await Promise.all([
        make(CreatePromotion).execute(admin, body),
        make(CreatePromotion).execute(admin, body),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error.code))).toEqual([
        'promotions.code-taken',
      ]);
    });

    it('queues a promotion of a new seller, approves it once and records the opt-in of a campaign', async () => {
      await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      const newcomer = ids.next<'Seller'>();
      activity.since.set(newcomer, clock.now().subtract({ hours: 24 }));
      const newSeller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: newcomer,
        }),
        'promo-db-seller-2',
      );
      const pending = await make(CreateOwnPromotion).execute(newSeller, {
        type: 'SELLER_SALE',
        name: 'Newcomer sale',
        funding: 'SELLER',
        startsAt: clock.now().subtract({ hours: 24 }).toString(),
        reward: { kind: 'PERCENT', bps: 1000 },
        productIds: [ids.next<'Product'>()],
      });
      expect(pending.ok && pending.value.status).toBe('PENDING_APPROVAL');
      if (!pending.ok) return;

      const queue = await make(ListPromotionReviews).execute(admin, {});
      expect(queue.ok).toBe(true);
      if (!queue.ok) return;
      const entry = queue.value.find((item) => item.promotion.id === pending.value.id);
      expect(entry?.review.reason).toBe('NEW_SELLER');
      const version = entry!.promotion.updatedAt.toString();
      const decided = await make(DecidePromotionReview).execute(admin, {
        reviewId: entry!.review.id,
        decision: 'APPROVE',
        promotionVersion: version,
      });
      expect(decided.ok).toBe(true);
      expect(
        await make(DecidePromotionReview).execute(admin, {
          reviewId: entry!.review.id,
          decision: 'APPROVE',
          promotionVersion: version,
        }),
      ).toEqual({ ok: false, error: { code: 'promotions.invalid-state' } });
      const stored = await rows(`SELECT status FROM promotions.promotions WHERE id = $1`, [
        pending.value.id,
      ]);
      expect(stored[0]?.status).toBe('ACTIVE');

      const campaign = await make(CreatePromotion).execute(
        admin,
        platformCart({
          type: 'CO_FUNDED_CAMPAIGN',
          funding: 'CO_FUNDED',
          platformSplitBps: 5000,
          name: 'Campaign',
        }),
      );
      expect(campaign.ok).toBe(true);
      if (!campaign.ok) return;
      const opted = await make(SetCoFundingOptIn).execute(seller, {
        promotionId: campaign.value.id,
        optIn: true,
      });
      expect(opted.ok && opted.value.optedIn).toBe(true);
      const live = await rows(
        `SELECT withdrawn_at FROM promotions.co_funding_opt_ins WHERE promotion_id = $1 AND seller_id = $2`,
        [campaign.value.id, sellerId],
      );
      expect(live).toHaveLength(1);
      expect(live[0]?.withdrawn_at).toBeNull();
      await make(SetCoFundingOptIn).execute(seller, {
        promotionId: campaign.value.id,
        optIn: false,
      });
      const withdrawn = await rows(
        `SELECT withdrawn_at FROM promotions.co_funding_opt_ins WHERE promotion_id = $1 AND seller_id = $2`,
        [campaign.value.id, sellerId],
      );
      expect(withdrawn[0]?.withdrawn_at).not.toBeNull();
    });

    it('stores a zone threshold and removes it again', async () => {
      await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      const zone = `t-${run}`.toLowerCase();
      expect(
        (
          await make(SetFreeShippingThreshold).execute(admin, {
            zoneCode: zone,
            thresholdMinor: '12345',
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await rows(
            `SELECT threshold_minor FROM promotions.free_shipping_thresholds WHERE zone_code = $1`,
            [zone],
          )
        )[0]?.threshold_minor,
      ).toBe('12345');
      await make(SetFreeShippingThreshold).execute(admin, { zoneCode: zone, thresholdMinor: null });
      expect(
        await rows(`SELECT 1 FROM promotions.free_shipping_thresholds WHERE zone_code = $1`, [
          zone,
        ]),
      ).toHaveLength(0);
    });

    it('moves the one open review of a promotion to the new reason when the seller edits again', async () => {
      await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      const body = (extra: Record<string, unknown> = {}) => ({
        type: 'SELLER_SALE',
        name: 'Reviewed sale',
        funding: 'SELLER',
        startsAt: clock.now().subtract({ hours: 24 }).toString(),
        reward: { kind: 'PERCENT', bps: 1000 },
        productIds: [ids.next<'Product'>()],
        ...extra,
      });
      const created = await make(CreateOwnPromotion).execute(seller, body());
      if (!created.ok) throw new Error('create failed');
      const open = () =>
        rows(
          `SELECT id, reason, opened_at, decided_at FROM promotions.promotion_reviews
            WHERE promotion_id = $1 AND status = 'OPEN'`,
          [created.value.id],
        );
      const [first] = await open();
      expect(first?.reason).toBe('POST_REVIEW');

      clock.advance(Temporal.Duration.from({ hours: 2 }));
      const edited = await make(EditOwnPromotion).execute(seller, {
        ...body({
          reward: { kind: 'PERCENT', bps: rules.priorApprovalDiscountBps + 100 },
          productIds: [...created.value.productIds],
        }),
        promotionId: created.value.id,
      });
      expect(edited.ok && edited.value.status).toBe('PENDING_APPROVAL');
      const after = await open();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: first?.id, reason: 'HIGH_DISCOUNT', decided_at: null });
      expect((after[0]?.opened_at as Date).getTime()).toBe(clock.now().epochMilliseconds);

      // The admin decides on the version they read; the edit above made an older one stale.
      const stale = await make(DecidePromotionReview).execute(admin, {
        reviewId: first?.id,
        decision: 'APPROVE',
        promotionVersion: created.value.updatedAt.toString(),
      });
      expect(stale).toEqual({ ok: false, error: { code: 'promotions.invalid-state' } });
      const current = await make(DecidePromotionReview).execute(admin, {
        reviewId: first?.id,
        decision: 'APPROVE',
        promotionVersion: edited.ok ? edited.value.updatedAt.toString() : '',
      });
      expect(current.ok).toBe(true);
    });

    it('withdraws the opt-ins of a campaign whose terms an admin changed', async () => {
      await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      const campaign = (extra: Record<string, unknown> = {}) =>
        platformCart({
          type: 'CO_FUNDED_CAMPAIGN',
          funding: 'CO_FUNDED',
          platformSplitBps: 5000,
          name: 'Terms',
          ...extra,
        });
      const created = await make(CreatePromotion).execute(admin, campaign());
      if (!created.ok) throw new Error('create failed');
      await make(SetCoFundingOptIn).execute(seller, { promotionId: created.value.id, optIn: true });
      const live = () =>
        rows(
          `SELECT 1 FROM promotions.co_funding_opt_ins WHERE promotion_id = $1 AND withdrawn_at IS NULL`,
          [created.value.id],
        );
      expect(await live()).toHaveLength(1);
      await make(EditPromotion).execute(admin, {
        ...campaign({ name: 'Renamed' }),
        promotionId: created.value.id,
      });
      expect(await live()).toHaveLength(1);
      const changed = await make(EditPromotion).execute(admin, {
        ...campaign({ reward: { kind: 'PERCENT', bps: 700 } }),
        promotionId: created.value.id,
      });
      expect(changed.ok).toBe(true);
      expect(await live()).toHaveLength(0);
    });

    it('reads only the promotions a cart can reach, and counts what counts against a seller', async () => {
      await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      const other = ids.next<'Seller'>();
      activity.since.set(other, clock.now().subtract({ hours: 24 * 400 }));
      const otherSeller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: other,
        }),
        'promo-db-seller-3',
      );
      const sale = (productId: Id<'Product'>) => ({
        type: 'SELLER_SALE',
        name: 'Scoped',
        funding: 'SELLER',
        startsAt: clock.now().subtract({ hours: 24 }).toString(),
        reward: { kind: 'PERCENT', bps: 1000 },
        productIds: [productId],
      });
      const wanted = ids.next<'Product'>();
      const mine = await make(CreateOwnPromotion).execute(seller, sale(wanted));
      const elsewhere = await make(CreateOwnPromotion).execute(seller, sale(ids.next<'Product'>()));
      const theirs = await make(CreateOwnPromotion).execute(otherSeller, sale(wanted));
      const platform = await make(CreatePromotion).execute(admin, platformCart());
      if (!mine.ok || !elsewhere.ok || !theirs.ok || !platform.ok) throw new Error('setup failed');

      const inUnit = <T>(read: () => Promise<T>) =>
        deps.unitOfWork.run(market, async () => ({ ok: true as const, value: await read() }), {
          readOnly: true,
        });
      const read = await inUnit(() =>
        deps.promotions.listLive(market, clock.now(), {
          sellerIds: [sellerId],
          productIds: [wanted],
        }),
      );
      const live = read.ok ? read.value : [];
      const seen = live.map((r) => r.id);
      expect(seen).toContain(mine.value.id);
      expect(seen).toContain(platform.value.id);
      expect(seen).not.toContain(elsewhere.value.id);
      expect(seen).not.toContain(theirs.value.id);

      const count = async () => {
        const counted = await inUnit(() =>
          deps.promotions.countCounting(market, other, clock.now()),
        );
        return counted.ok ? counted.value : -1;
      };
      expect(await count()).toBe(1);
      await make(PauseOwnPromotion).execute(otherSeller, { promotionId: theirs.value.id });
      expect(await count()).toBe(0);
    });

    it('serialises two parallel changes of one promotion on its row', async () => {
      await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      const created = await make(CreatePromotion).execute(admin, platformCart());
      if (!created.ok) throw new Error('create failed');
      const results = await Promise.all([
        make(SetPromotionBudget).execute(admin, {
          promotionId: created.value.id,
          budgetMinor: '5000',
        }),
        make(SetPromotionBudget).execute(admin, {
          promotionId: created.value.id,
          budgetMinor: '6000',
        }),
      ]);
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      const stored = await rows(`SELECT budget_minor FROM promotions.promotions WHERE id = $1`, [
        created.value.id,
      ]);
      expect(['5000', '6000']).toContain(String(stored[0]?.budget_minor));
      const missing = await deps.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await deps.promotions.findForUpdate(market, ids.next<'Promotion'>()),
      }));
      expect(missing.ok && missing.value).toBeNull();
    });

    it('uses the Market rules of its own configuration', () => {
      expect(rules.platformBudgetStepUpMinor).toBeGreaterThan(0);
    });
  });
});
