import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { PromotionsDependencies } from '../../src/modules/promotions/application/promotions-dependencies';
import { ApplyReferralCode } from '../../src/modules/promotions/application/use-cases/apply-referral-code.use-case';
import { CashbackOnDelivery } from '../../src/modules/promotions/application/use-cases/cashback-on-delivery.use-case';
import { CreatePromotion } from '../../src/modules/promotions/application/use-cases/create-promotion.use-case';
import { QualifyReferralOnDelivery } from '../../src/modules/promotions/application/use-cases/qualify-referral-on-delivery.use-case';
import { SetPromotionsStatus } from '../../src/modules/promotions/application/use-cases/set-promotions-status.use-case';
import { ViewMyReferral } from '../../src/modules/promotions/application/use-cases/view-my-referral.use-case';
import { ConfigPromotionsPolicy } from '../../src/modules/promotions/infrastructure/config-promotions-policy';
import { CryptoBatchCodeCrypto } from '../../src/modules/promotions/infrastructure/crypto-batch-code-crypto';
import { PrismaBatchCodeRepository } from '../../src/modules/promotions/infrastructure/prisma-batch-code.repository';
import { PrismaCreditRepository } from '../../src/modules/promotions/infrastructure/prisma-credit.repository';
import { PrismaMarketSettingRepository } from '../../src/modules/promotions/infrastructure/prisma-market-setting.repository';
import { PrismaOptInRepository } from '../../src/modules/promotions/infrastructure/prisma-opt-in.repository';
import { PrismaPromotionRepository } from '../../src/modules/promotions/infrastructure/prisma-promotion.repository';
import { PrismaReferralRepository } from '../../src/modules/promotions/infrastructure/prisma-referral.repository';
import { PrismaReviewQueueRepository } from '../../src/modules/promotions/infrastructure/prisma-review-queue.repository';
import {
  PrismaFirstOrderSettingsRepository,
  PrismaShippingThresholdRepository,
} from '../../src/modules/promotions/infrastructure/prisma-settings.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { HandledOnce, UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import {
  FakeFlashSales,
  FakePriceHistory,
  FakeSellerActivity,
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

// The phase 3 types on the real stores in both Market fixtures: the guards of the new columns and
// tables (segment, referral and cashback terms, referral codes, referrals, credit issuances, the
// inbox), their privileges, the repositories, and the two delivery handlers end to end against
// the real unit of work (the inbox of `runOnce` is an in-memory set here, as in pricing's spec; the
// inbox table has its own checks below). Rows are never deleted, so every test names its own ids.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const HASH = (n: number) => n.toString(16).padStart(64, '0');

/** TRUNCATE ... CASCADE retried while another spec file holds the tables (deadlock or lock timeout). */
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

describe.each(TEST_MARKETS)('promotions phase 3 types in market %s (database)', (code) => {
  const market = marketOf(code);
  const mk = market.marketId;
  const policy = new ConfigPromotionsPolicy(markets);
  const settings = policy.settings(market)!;
  const currency = settings.currency;
  const confirmed = settings.rules.gstRulingConfirmed;
  const clock = new FixedClock(Temporal.Instant.from('2026-10-25T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'promo3-db-system-1');
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'promo3-db-admin-1',
  );
  const sellerId = ids.next<'Seller'>();

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let deps: PromotionsDependencies;
  let facts: ReturnType<typeof phase3Fakes>;
  const inbox = new Set<string>();

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    facts = phase3Fakes();
    const activity = new FakeSellerActivity();
    activity.since.set(sellerId, clock.now().subtract({ hours: 24 * 400 }));
    const unitOfWork: UnitOfWork = {
      run: (...args) => db.unitOfWork.run(...args),
      runOnce: async <T, E>(
        m: Parameters<UnitOfWork['runOnce']>[0],
        delivery: EventDelivery,
        work: () => Promise<Result<T, E>>,
        options?: Parameters<UnitOfWork['runOnce']>[3],
      ): Promise<Result<HandledOnce<T>, E>> => {
        const key = `${m.marketId}|${delivery.eventId}|${delivery.subscriber}`;
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
      flashSales: new FakeFlashSales(),
      sellerActivity: activity,
      priceHistory: new FakePriceHistory(),
      ...facts,
      credits: new PrismaCreditRepository(db.service),
      referrals: new PrismaReferralRepository(db.service),
      stepUp: new FakeStepUp(() => clock.now()),
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

  const insert = (
    table: string,
    values: Record<string, unknown>,
    client: Client = sql,
  ): [string, unknown[], Client] => {
    const keys = Object.keys(values);
    return [
      `INSERT INTO promotions.${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values),
      client,
    ];
  };
  const attempt = ([text, values, client]: [string, unknown[], Client]) =>
    state(client.query(text, values));

  const promotionRow = (overrides: Record<string, unknown> = {}) => ({
    id: ids.next<'Promotion'>(),
    market_id: mk,
    tenant_id: 'default',
    type: 'CASHBACK',
    status: 'ACTIVE',
    name: 'Phase 3',
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
    cap_minor: 2000,
    max_per_order_minor: null,
    max_total_uses: null,
    max_uses_per_customer: null,
    budget_minor: 100000,
    min_spend_minor: null,
    created_by_account_id: ids.next<'Account'>(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
  const promotion = (overrides: Record<string, unknown> = {}) =>
    insert('promotions', promotionRow(overrides));
  const referralTerms = {
    type: 'REFERRAL',
    reward_kind: 'FIXED',
    reward_bps: null,
    reward_amount_minor: 1000,
    cap_minor: null,
    referee_reward_minor: 800,
    max_uses_per_customer: 3,
  };

  describe('the promotion columns', () => {
    it('accepts the four new types with their funding and refuses the wrong funding', async () => {
      expect(await attempt(promotion())).toBe('allowed');
      expect(await attempt(promotion(referralTerms))).toBe('allowed');
      expect(
        await attempt(
          promotion({
            type: 'CUSTOMER_GROUP',
            segment_kind: 'RETURNING_CUSTOMER',
            segment_min_days: 60,
            cap_minor: null,
          }),
        ),
      ).toBe('allowed');
      const follower = {
        type: 'STORE_FOLLOWER',
        funding: 'SELLER',
        owner_seller_id: sellerId,
        budget_minor: null,
        cap_minor: null,
      };
      expect(await attempt(promotion(follower))).toBe('allowed');
      expect(await attempt(promotion({ ...follower, funding: 'PLATFORM' }))).toBe(CHECK);
      for (const type of ['CASHBACK', 'REFERRAL', 'CUSTOMER_GROUP']) {
        expect(
          await attempt(
            promotion({
              ...referralTerms,
              type,
              funding: 'SELLER',
              owner_seller_id: sellerId,
              budget_minor: null,
            }),
          ),
        ).toBe(CHECK);
      }
    });

    it('holds the segment to the customer-group type and to its kind', async () => {
      const group = { type: 'CUSTOMER_GROUP', cap_minor: null };
      const returning = { ...group, segment_kind: 'RETURNING_CUSTOMER', segment_min_days: 60 };
      expect(await attempt(promotion({ ...returning, segment_min_days: null }))).toBe(CHECK);
      expect(await attempt(promotion({ ...returning, segment_min_days: 0 }))).toBe(CHECK);
      expect(await attempt(promotion({ ...returning, segment_min_days: 3651 }))).toBe(CHECK);
      expect(await attempt(promotion({ ...group, segment_kind: 'DELIVERY_ZONE' }))).toBe('allowed');
      expect(
        await attempt(promotion({ ...group, segment_kind: 'DELIVERY_ZONE', segment_min_days: 5 })),
      ).toBe(CHECK);
      expect(await attempt(promotion(group))).toBe(CHECK);
      expect(await attempt(promotion({ ...group, segment_kind: 'EVERYONE' }))).toBe(CHECK);
      expect(await attempt(promotion({ ...returning, referee_reward_minor: 5 }))).toBe(CHECK);
      // Another type carries none of the phase 3 columns.
      expect(await attempt(promotion({ segment_kind: 'DELIVERY_ZONE' }))).toBe(CHECK);
      expect(await attempt(promotion({ segment_min_days: 3 }))).toBe(CHECK);
      expect(await attempt(promotion({ referee_reward_minor: 5 }))).toBe(CHECK);
    });

    it('holds a referral to fixed rewards and a per-referrer cap, and a cashback to a percent and a cap', async () => {
      expect(await attempt(promotion({ ...referralTerms, referee_reward_minor: null }))).toBe(
        CHECK,
      );
      expect(await attempt(promotion({ ...referralTerms, referee_reward_minor: 0 }))).toBe(CHECK);
      expect(await attempt(promotion({ ...referralTerms, max_uses_per_customer: null }))).toBe(
        CHECK,
      );
      expect(
        await attempt(
          promotion({
            ...referralTerms,
            reward_kind: 'PERCENT',
            reward_bps: 500,
            reward_amount_minor: null,
          }),
        ),
      ).toBe(CHECK);
      expect(await attempt(promotion({ ...referralTerms, cap_minor: 100 }))).toBe(CHECK);
      expect(await attempt(promotion({ cap_minor: null }))).toBe(CHECK);
      expect(
        await attempt(
          promotion({ reward_kind: 'FIXED', reward_bps: null, reward_amount_minor: 100 }),
        ),
      ).toBe(CHECK);
    });

    it('lets the app role change the new columns and no other column of the type', async () => {
      const row = promotionRow({
        type: 'CUSTOMER_GROUP',
        cap_minor: null,
        segment_kind: 'DELIVERY_ZONE',
      });
      await sql.query(...(insert('promotions', row).slice(0, 2) as [string, unknown[]]));
      expect(
        await state(
          sql.query(
            'UPDATE promotions.promotions SET segment_kind = $3, segment_min_days = $4 WHERE market_id = $1 AND id = $2',
            [mk, row.id, 'RETURNING_CUSTOMER', 30],
          ),
        ),
      ).toBe('allowed');
      expect(
        await state(
          sql.query('UPDATE promotions.promotions SET type = $3 WHERE market_id = $1 AND id = $2', [
            mk,
            row.id,
            'CASHBACK',
          ]),
        ),
      ).toBe(NO_PRIVILEGE);
    });
  });

  describe('referral codes', () => {
    const account = () => ids.next<'Account'>();
    const codeRow = (overrides: Record<string, unknown> = {}) => ({
      market_id: mk,
      tenant_id: 'default',
      account_id: account(),
      code_hash: HASH(Number(`${Math.floor(Math.random() * 1e9)}`)),
      created_at: new Date(),
      ...overrides,
    });

    it('stores a hash, one code per customer and a hash once per Market', async () => {
      const row = codeRow();
      expect(await attempt(insert('referral_codes', row))).toBe('allowed');
      expect(await attempt(insert('referral_codes', { ...row, code_hash: HASH(1) + '' }))).toBe(
        UNIQUE,
      );
      expect(await attempt(insert('referral_codes', codeRow({ code_hash: row.code_hash })))).toBe(
        UNIQUE,
      );
      expect(await attempt(insert('referral_codes', codeRow({ code_hash: 'PLAINCODE123' })))).toBe(
        CHECK,
      );
      expect(await attempt(insert('referral_codes', codeRow({ market_id: 'bad' })))).toBe(CHECK);
    });

    it('is never changed, deleted or truncated', async () => {
      const row = codeRow();
      await sql.query(...(insert('referral_codes', row).slice(0, 2) as [string, unknown[]]));
      expect(
        await state(
          sql.query(
            'UPDATE promotions.referral_codes SET code_hash = $3 WHERE market_id = $1 AND account_id = $2',
            [mk, row.account_id, HASH(7)],
          ),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await state(
          sql.query('DELETE FROM promotions.referral_codes WHERE account_id = $1', [
            row.account_id,
          ]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await state(
          owner.query('DELETE FROM promotions.referral_codes WHERE account_id = $1', [
            row.account_id,
          ]),
        ),
      ).toBe(RESTRICT);
      expect(await truncateState(owner, 'referral_codes')).toBe(RESTRICT);
    });
  });

  describe('referrals', () => {
    let promotionId: string;
    beforeAll(async () => {
      const row = promotionRow(referralTerms);
      await sql.query(...(insert('promotions', row).slice(0, 2) as [string, unknown[]]));
      promotionId = row.id;
    });
    const referralRow = (overrides: Record<string, unknown> = {}) => ({
      id: ids.next<'Referral'>(),
      market_id: mk,
      tenant_id: 'default',
      promotion_id: promotionId,
      referrer_account_id: ids.next<'Account'>(),
      referee_account_id: ids.next<'Account'>(),
      status: 'PENDING',
      reject_reason: null,
      created_at: new Date('2026-10-25T10:00:00Z'),
      expires_at: new Date('2026-11-25T10:00:00Z'),
      decided_at: null,
      qualifying_order_id: null,
      qualifying_seller_order_id: null,
      ...overrides,
    });

    it('refuses a self-referral, a second referral of one customer and an unknown promotion', async () => {
      const row = referralRow();
      expect(await attempt(insert('referrals', row))).toBe('allowed');
      expect(
        await attempt(
          insert('referrals', referralRow({ referee_account_id: row.referee_account_id })),
        ),
      ).toBe(UNIQUE);
      const same = ids.next<'Account'>();
      expect(
        await attempt(
          insert('referrals', referralRow({ referrer_account_id: same, referee_account_id: same })),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(insert('referrals', referralRow({ promotion_id: ids.next<'Promotion'>() }))),
      ).toBe(FOREIGN_KEY);
    });

    it('keeps status, reject reason, decision time and qualifying order consistent', async () => {
      const decided = new Date('2026-10-26T10:00:00Z');
      expect(await attempt(insert('referrals', referralRow({ status: 'BOGUS' })))).toBe(CHECK);
      expect(
        await attempt(
          insert('referrals', referralRow({ status: 'REJECTED', decided_at: decided })),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          insert(
            'referrals',
            referralRow({ status: 'REJECTED', reject_reason: 'MAGIC', decided_at: decided }),
          ),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          insert(
            'referrals',
            referralRow({
              status: 'REJECTED',
              reject_reason: 'SAME_HOUSEHOLD',
              decided_at: decided,
            }),
          ),
        ),
      ).toBe('allowed');
      expect(
        await attempt(insert('referrals', referralRow({ reject_reason: 'SAME_PAYMENT' }))),
      ).toBe(CHECK);
      // Qualified needs both ids and a decision time; pending has none of them.
      expect(
        await attempt(
          insert('referrals', referralRow({ status: 'QUALIFIED', decided_at: decided })),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          insert(
            'referrals',
            referralRow({
              status: 'QUALIFIED',
              decided_at: decided,
              qualifying_order_id: ids.next<'Order'>(),
              qualifying_seller_order_id: ids.next<'SellerOrder'>(),
            }),
          ),
        ),
      ).toBe('allowed');
      expect(
        await attempt(
          insert('referrals', referralRow({ qualifying_order_id: ids.next<'Order'>() })),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(insert('referrals', referralRow({ status: 'PENDING', decided_at: decided }))),
      ).toBe(CHECK);
      expect(
        await attempt(
          insert('referrals', referralRow({ expires_at: new Date('2026-10-25T10:00:00Z') })),
        ),
      ).toBe(CHECK);
    });

    it('changes state only, is never deleted, and the repository decides a pending referral once', async () => {
      const row = referralRow();
      await sql.query(...(insert('referrals', row).slice(0, 2) as [string, unknown[]]));
      expect(
        await state(
          sql.query(
            'UPDATE promotions.referrals SET referrer_account_id = $3 WHERE market_id = $1 AND id = $2',
            [mk, row.id, ids.next<'Account'>()],
          ),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await state(sql.query('DELETE FROM promotions.referrals WHERE id = $1', [row.id])),
      ).toBe(NO_PRIVILEGE);
      expect(
        await state(owner.query('DELETE FROM promotions.referrals WHERE id = $1', [row.id])),
      ).toBe(RESTRICT);
      expect(await truncateState(owner, 'referrals')).toBe(RESTRICT);

      const repository = deps.referrals;
      const at = clock.now();
      const first = await db.unitOfWork.run(market, async () =>
        ok(await repository.decide(market, row.id as never, { status: 'EXPIRED' }, at)),
      );
      const second = await db.unitOfWork.run(market, async () =>
        ok(await repository.decide(market, row.id as never, { status: 'EXPIRED' }, at)),
      );
      expect([first, second]).toEqual([ok(true), ok(false)]);
    });
  });

  describe('credit issuances', () => {
    let promotionId: string;
    beforeAll(async () => {
      const row = promotionRow();
      await sql.query(...(insert('promotions', row).slice(0, 2) as [string, unknown[]]));
      promotionId = row.id;
    });
    const creditRow = (overrides: Record<string, unknown> = {}) => {
      const source = ids.next<'SellerOrder'>();
      return {
        id: ids.next<'PromotionCredit'>(),
        market_id: mk,
        tenant_id: 'default',
        promotion_id: promotionId,
        kind: 'CASHBACK',
        recipient_account_id: ids.next<'Account'>(),
        order_id: ids.next<'Order'>(),
        source_kind: 'SELLER_ORDER',
        source_id: source,
        amount_minor: 500,
        currency: 'AUD',
        status: 'PENDING',
        failure_code: null,
        wallet_journal_id: null,
        idempotency_key: `promotions:cashback:${source}`,
        created_at: new Date(),
        settled_at: null,
        ...overrides,
      };
    };

    it('is one credit per kind and source, and one per idempotency key', async () => {
      const row = creditRow();
      expect(await attempt(insert('credit_issuances', row))).toBe('allowed');
      expect(
        await attempt(insert('credit_issuances', creditRow({ source_id: row.source_id }))),
      ).toBe(UNIQUE);
      expect(
        await attempt(
          insert('credit_issuances', creditRow({ idempotency_key: row.idempotency_key })),
        ),
      ).toBe(UNIQUE);
    });

    it('holds the amount, kind and source, and the settlement fields together', async () => {
      const settled = new Date();
      expect(await attempt(insert('credit_issuances', creditRow({ amount_minor: 0 })))).toBe(CHECK);
      expect(await attempt(insert('credit_issuances', creditRow({ currency: 'aud' })))).toBe(CHECK);
      expect(
        await attempt(insert('credit_issuances', creditRow({ idempotency_key: 'short' }))),
      ).toBe(CHECK);
      // A cashback comes from a seller order with its order; a referral credit from a referral.
      expect(await attempt(insert('credit_issuances', creditRow({ order_id: null })))).toBe(CHECK);
      expect(
        await attempt(insert('credit_issuances', creditRow({ source_kind: 'REFERRAL' }))),
      ).toBe(CHECK);
      expect(await attempt(insert('credit_issuances', creditRow({ kind: 'REFEREE_REWARD' })))).toBe(
        CHECK,
      );
      expect(
        await attempt(
          insert(
            'credit_issuances',
            creditRow({ kind: 'REFEREE_REWARD', source_kind: 'REFERRAL', order_id: null }),
          ),
        ),
      ).toBe('allowed');
      expect(await attempt(insert('credit_issuances', creditRow({ status: 'NOPE' })))).toBe(CHECK);
      expect(
        await attempt(
          insert('credit_issuances', creditRow({ status: 'GRANTED', settled_at: settled })),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          insert(
            'credit_issuances',
            creditRow({
              status: 'GRANTED',
              settled_at: settled,
              wallet_journal_id: ids.next<'WalletJournal'>(),
            }),
          ),
        ),
      ).toBe('allowed');
      expect(
        await attempt(
          insert('credit_issuances', creditRow({ status: 'RECORDED', settled_at: settled })),
        ),
      ).toBe('allowed');
      expect(await attempt(insert('credit_issuances', creditRow({ status: 'RECORDED' })))).toBe(
        CHECK,
      );
      expect(
        await attempt(
          insert('credit_issuances', creditRow({ status: 'FAILED', settled_at: settled })),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          insert(
            'credit_issuances',
            creditRow({
              status: 'FAILED',
              settled_at: settled,
              failure_code: 'wallet.cap-exceeded',
            }),
          ),
        ),
      ).toBe('allowed');
      expect(
        await attempt(
          insert('credit_issuances', creditRow({ failure_code: 'wallet.cap-exceeded' })),
        ),
      ).toBe(CHECK);
      expect(
        await attempt(
          insert('credit_issuances', creditRow({ promotion_id: ids.next<'Promotion'>() })),
        ),
      ).toBe(FOREIGN_KEY);
    });

    it('changes state only, never the amount or recipient, and is never deleted', async () => {
      const row = creditRow();
      await sql.query(...(insert('credit_issuances', row).slice(0, 2) as [string, unknown[]]));
      for (const column of ['amount_minor', 'recipient_account_id', 'idempotency_key', 'kind']) {
        expect(
          await state(
            sql.query(
              `UPDATE promotions.credit_issuances SET ${column} = ${column} WHERE market_id = $1 AND id = $2`,
              [mk, row.id],
            ),
          ),
        ).toBe(NO_PRIVILEGE);
      }
      expect(
        await state(sql.query('DELETE FROM promotions.credit_issuances WHERE id = $1', [row.id])),
      ).toBe(NO_PRIVILEGE);
      expect(
        await state(owner.query('DELETE FROM promotions.credit_issuances WHERE id = $1', [row.id])),
      ).toBe(RESTRICT);
      expect(await truncateState(owner, 'credit_issuances')).toBe(RESTRICT);
    });
  });

  describe('the inbox', () => {
    it('is appended to once per event and handler, for promotions handlers only', async () => {
      const row = (overrides: Record<string, unknown> = {}) => ({
        event_id: ids.next<'event'>(),
        handler: 'promotions.cashback-on-delivery',
        market_id: mk,
        tenant_id: 'default',
        processed_at: new Date(),
        ...overrides,
      });
      const first = row();
      expect(await attempt(insert('inbox', first))).toBe('allowed');
      expect(await attempt(insert('inbox', { ...first, processed_at: new Date() }))).toBe(UNIQUE);
      expect(await attempt(insert('inbox', row({ handler: 'pricing.other' })))).toBe(CHECK);
      expect(
        await state(
          sql.query('DELETE FROM promotions.inbox WHERE event_id = $1', [first.event_id]),
        ),
      ).toBe(NO_PRIVILEGE);
    });
  });

  describe('the repositories', () => {
    it('round-trip a credit, count it, and settle it once', async () => {
      const row = promotionRow();
      await sql.query(...(insert('promotions', row).slice(0, 2) as [string, unknown[]]));
      const credit = {
        id: ids.next<'PromotionCredit'>(),
        promotionId: row.id as never,
        kind: 'CASHBACK' as const,
        recipientAccountId: ids.next<'Account'>(),
        orderId: ids.next<'Order'>(),
        sourceKind: 'SELLER_ORDER' as const,
        sourceId: ids.next<'SellerOrder'>(),
        amountMinor: 321n,
        currency: 'AUD',
        status: 'PENDING' as const,
        failureCode: null,
        walletJournalId: null,
        idempotencyKey: `promotions:cashback:${ids.next<'x'>()}`,
        createdAt: clock.now(),
        settledAt: null,
      };
      const credits = deps.credits;
      const result = await db.unitOfWork.run(market, async () => {
        const inserted = await credits.insert(market, credit);
        const again = await credits
          .insert(market, { ...credit, id: ids.next<'PromotionCredit'>() })
          .catch(() => 'threw');
        return ok({ inserted, again });
      });
      expect(result.ok && result.value.inserted).toBe('inserted');
      expect(result.ok && result.value.again).toBe('duplicate');
      const read = await db.unitOfWork.run(market, async () =>
        ok({
          found: await credits.findBySource(market, 'CASHBACK', credit.sourceId),
          reserved: await credits.reservedTotal(market, credit.promotionId),
          live: await credits.countLive(market, credit.promotionId, credit.recipientAccountId),
          forOrder: await credits.creditedForOrder(market, credit.orderId, 'CASHBACK'),
        }),
      );
      expect(read.ok && read.value).toMatchObject({ reserved: 321n, live: 1, forOrder: 321n });
      expect(read.ok && read.value.found).toMatchObject({
        id: credit.id,
        status: 'PENDING',
        amountMinor: 321n,
      });
      const journal = ids.next<'WalletJournal'>();
      const settle = () =>
        db.unitOfWork.run(market, async () =>
          ok(
            await credits.settle(
              market,
              credit.id,
              { status: 'GRANTED', walletJournalId: journal },
              clock.now(),
            ),
          ),
        );
      expect([await settle(), await settle()]).toEqual([ok(true), ok(false)]);
    });
  });

  describe('the delivery handlers end to end', () => {
    const delivery = (subscriber: string): EventDelivery => ({
      eventId: ids.next<'event'>(),
      subscriber,
      attempt: 1,
    });
    const deliver = (who: string, goodsMinor: bigint) => {
      const order = {
        orderId: ids.next<'Order'>(),
        sellerOrderId: ids.next<'SellerOrder'>(),
        customerAccountId: who as never,
        goodsPaid: money(goodsMinor, currency),
        placedAt: clock.now().add({ hours: 1 }),
        deliveredAt: clock.now().add({ hours: 48 }),
        testOrder: false,
      };
      facts.orderFacts.add(order);
      return order;
    };

    beforeAll(async () => {
      const on = await make(SetPromotionsStatus).execute(admin, { status: 'active' });
      expect(on.ok).toBe(true);
      const base = {
        funding: 'PLATFORM',
        startsAt: '2026-10-01T00:00:00Z',
        budgetMinor: '100000',
        testMode: !confirmed,
      };
      for (const body of [
        {
          ...base,
          type: 'CASHBACK',
          name: 'DB cashback',
          reward: { kind: 'PERCENT', bps: 500 },
          capMinor: '2000',
        },
        {
          ...base,
          type: 'REFERRAL',
          name: 'DB referral',
          reward: { kind: 'FIXED', amountMinor: '1000' },
          refereeRewardMinor: '800',
          maxUsesPerCustomer: 2,
        },
      ]) {
        const made = await make(CreatePromotion).execute(admin, body);
        expect(made).toMatchObject({ ok: true });
      }
    });

    it('credits cashback once, through the real tables, however often the event comes', async () => {
      const customer = ids.next<'Account'>();
      const order = deliver(customer, 10000n);
      const input = (d: EventDelivery) => ({
        delivery: d,
        orderId: order.orderId,
        sellerOrderId: order.sellerOrderId,
      });
      const d = delivery('promotions.cashback-on-delivery');
      const first = await make(CashbackOnDelivery).execute(system, input(d));
      expect(first).toEqual({ ok: true, value: { outcome: confirmed ? 'issued' : 'recorded' } });
      expect(await make(CashbackOnDelivery).execute(system, input(d))).toEqual({
        ok: true,
        value: { outcome: 'already-handled' },
      });
      await make(CashbackOnDelivery).execute(
        system,
        input(delivery('promotions.cashback-on-delivery')),
      );
      const stored = await rows(
        'SELECT status, amount_minor::text AS amount, wallet_journal_id FROM promotions.credit_issuances WHERE market_id = $1 AND order_id = $2',
        [mk, order.orderId],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        amount: '500',
        status: confirmed ? 'GRANTED' : 'RECORDED',
      });
      expect(facts.walletCredit.grants.filter((g) => g.orderId === order.orderId)).toHaveLength(
        confirmed ? 1 : 0,
      );
    });

    it('applies a code, then credits both customers once when the first order is delivered', async () => {
      const referrer = ids.next<'Account'>();
      const newcomer = ids.next<'Account'>();
      const as = (accountId: string) =>
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'customer',
            accountId: accountId as never,
            sessionId: ids.next<'Session'>(),
            sellerId: null,
          }),
          'promo3-db-customer-1',
        );
      const mine = await make(ViewMyReferral).execute(as(referrer), {});
      if (!mine.ok) throw new Error(`view failed ${JSON.stringify(mine.error)}`);
      const again = await make(ViewMyReferral).execute(as(referrer), {});
      expect(again.ok && again.value.code).toBe(mine.value.code);
      facts.orderHistory.lastOrder.set(newcomer, null);
      const applied = await make(ApplyReferralCode).execute(as(newcomer), {
        code: mine.value.code,
      });
      expect(applied.ok).toBe(true);
      expect(
        await make(ApplyReferralCode).execute(as(newcomer), { code: mine.value.code }),
      ).toEqual({ ok: false, error: { code: 'promotions.referral-not-eligible' } });

      const order = deliver(newcomer, 5000n);
      const input = (d: EventDelivery) => ({
        delivery: d,
        orderId: order.orderId,
        sellerOrderId: order.sellerOrderId,
      });
      const d = delivery('promotions.qualify-referral-on-delivery');
      const result = await make(QualifyReferralOnDelivery).execute(system, input(d));
      expect(result).toEqual({ ok: true, value: { outcome: confirmed ? 'issued' : 'recorded' } });
      await make(QualifyReferralOnDelivery).execute(system, input(d));
      await make(QualifyReferralOnDelivery).execute(
        system,
        input(delivery('promotions.qualify-referral-on-delivery')),
      );
      const stored = await rows(
        'SELECT kind, recipient_account_id::text AS recipient, amount_minor::text AS amount FROM promotions.credit_issuances WHERE market_id = $1 AND order_id = $2 ORDER BY kind',
        [mk, order.orderId],
      );
      expect(stored).toEqual([
        { kind: 'REFEREE_REWARD', recipient: newcomer, amount: '800' },
        { kind: 'REFERRER_REWARD', recipient: referrer, amount: '1000' },
      ]);
      const referral = await rows(
        'SELECT status FROM promotions.referrals WHERE market_id = $1 AND referee_account_id = $2',
        [mk, newcomer],
      );
      expect(referral).toEqual([{ status: 'QUALIFIED' }]);
      // Only the hash of the code is stored.
      const codes = await rows(
        'SELECT code_hash FROM promotions.referral_codes WHERE market_id = $1 AND account_id = $2',
        [mk, referrer],
      );
      expect(codes[0]!.code_hash).not.toBe(mine.value.code);
    });
  });
});
