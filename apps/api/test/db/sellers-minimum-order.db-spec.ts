import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { readSellerSummaries } from '../../src/modules/sellers/application/summaries/read-seller-summaries';
import { StoreSettingsRead } from '../../src/modules/sellers/application/use-cases/store-settings-read.use-case';
import { StoreSettingsSaveMinimumOrder } from '../../src/modules/sellers/application/use-cases/store-settings-save-minimum-order.use-case';
import { SellerFile } from '../../src/modules/sellers/domain/seller-file';
import { HmacRateCounterKeys } from '../../src/modules/sellers/infrastructure/hmac-rate-counter-keys';
import { MarketConfigMinimumOrderPolicy } from '../../src/modules/sellers/infrastructure/market-config-minimum-order-policy';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { PrismaStoreProfileRepository } from '../../src/modules/sellers/infrastructure/prisma-store-profile.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { InMemoryCounters } from '../support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The seller's minimum order on PostgreSQL (sellers design 18; data design 3.8, A1), for both
// Market fixtures, as the application role: the four columns and their five CHECKs, the
// optimistic version, the approved-only batch read behind `sellerSummaries`, and the save use
// case end to end over the real unit of work.

const T0 = Temporal.Instant.from('2026-10-15T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigMinimumOrderPolicy(markets);
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(TEST_MARKETS)('the seller minimum order in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let files: PrismaSellerFileRepository;
  let profiles: PrismaStoreProfileRepository;
  let audits: AuditEntry[];

  beforeAll(async () => {
    db = createPersistence();
    files = new PrismaSellerFileRepository(db.service);
    profiles = new PrismaStoreProfileRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await db.close();
  });
  beforeEach(() => {
    audits = [];
  });

  async function newSeller(m: MarketContext = market, approved = false): Promise<Id<'Seller'>> {
    clock.advance(Temporal.Duration.from({ milliseconds: 2 }));
    const sellerId = ids.next<'Seller'>();
    const created = await db.unitOfWork.run(m, async () =>
      ok(
        await files.addWithRoots(
          m,
          SellerFile.create({
            sellerId,
            marketId: m.marketId,
            origin: 'self',
            approvalRequiredAtRegistration: true,
            now: T0,
          }),
        ),
      ),
    );
    if (!created.ok) throw new Error('unreachable');
    if (approved) {
      const revisionId = ids.next<'BusinessFileRevision'>();
      await owner.query(
        `INSERT INTO sellers.business_file_revisions
          (id, market_id, tenant_id, seller_id, kind, revision_no, status, author_kind, author_account_id,
           content_ciphertext, content_schema_version, content_hash, operating_timezone, service_area_code,
           register_outcome, register_mismatches, created_at, status_changed_at, decided_at)
         VALUES ($1, $2, $3, $4, 'onboarding', 1, 'approved', 'seller', $5, $6, 1, $7, 'Australia/Brisbane', 'open',
                 'not-performed', '{}', $8, $8, $8)`,
        [
          revisionId,
          m.marketId,
          m.tenantId,
          sellerId,
          ACCOUNT,
          `v1.${'A'.repeat(77)}`,
          `hmac-sha256:${'2'.padStart(64, '0')}`,
          T0.toString(),
        ],
      );
      await owner.query(
        "UPDATE sellers.seller_files SET approved_revision_id = $3, public_store_name = 'Shop' WHERE market_id = $1 AND seller_id = $2",
        [m.marketId, sellerId, revisionId],
      );
    }
    return sellerId;
  }

  const inUnit = async <T>(
    work: () => Promise<T>,
    m: MarketContext = market,
    readOnly = true,
  ): Promise<T> => {
    const result = await db.unitOfWork.run(m, async () => ok(await work()), { readOnly });
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  };

  const write = (sellerId: Id<'Seller'>, set: string, params: unknown[] = []) =>
    sql.query(`UPDATE sellers.store_profiles SET ${set} WHERE market_id = $1 AND seller_id = $2`, [
      market.marketId,
      sellerId,
      ...params,
    ]);

  it('a created store profile reads no minimum at version 1 (null is none)', async () => {
    const sellerId = await newSeller(market, true);

    const found = await inUnit(() => profiles.find(market, sellerId));

    expect(found).toEqual({ version: 1, approved: true, minimumOrder: null });
  });

  it('reports a seller without an approved revision as not approved', async () => {
    const sellerId = await newSeller();

    expect(await inUnit(() => profiles.find(market, sellerId))).toMatchObject({ approved: false });
  });

  it('sets, reads back and clears the minimum under the version, and raises it each time', async () => {
    const sellerId = await newSeller(market, true);
    const change = (expectedVersion: number, minimumOrder: ReturnType<typeof money> | null) =>
      inUnit(
        () =>
          profiles.saveMinimumOrder(market, sellerId, {
            expectedVersion,
            minimumOrder,
            changedByAccountId: ACCOUNT,
            changedAt: T0,
          }),
        market,
        false,
      );

    expect(await change(1, money(2500n, currency))).toBe(2);
    expect(await inUnit(() => profiles.find(market, sellerId))).toEqual({
      version: 2,
      approved: true,
      minimumOrder: money(2500n, currency),
    });
    // A stale version writes nothing.
    expect(await change(1, money(9999n, currency))).toBeNull();
    expect(await change(2, null)).toBe(3);
    expect(await inUnit(() => profiles.find(market, sellerId))).toMatchObject({
      version: 3,
      minimumOrder: null,
    });
    const row = await sql.query(
      'SELECT minimum_order_changed_by_account_id AS who FROM sellers.store_profiles WHERE seller_id = $1',
      [sellerId],
    );
    expect((row.rows[0] as { who: string }).who).toBe(ACCOUNT);
  });

  it('stores a bigint amount beyond 32 bits without loss', async () => {
    const sellerId = await newSeller(market, true);
    const large = money(9_000_000_000n, currency);

    await inUnit(
      () =>
        profiles.saveMinimumOrder(market, sellerId, {
          expectedVersion: 1,
          minimumOrder: large,
          changedByAccountId: ACCOUNT,
          changedAt: T0,
        }),
      market,
      false,
    );

    expect((await inUnit(() => profiles.find(market, sellerId)))?.minimumOrder).toEqual(large);
  });

  it('refuses rows the five CHECKs forbid', async () => {
    const sellerId = await newSeller(market, true);
    const stamp = `minimum_order_changed_at = now(), minimum_order_changed_by_account_id = '${ACCOUNT}'`;
    const bad: [string, string][] = [
      ['an amount without a currency', `minimum_order_amount = 100, ${stamp}`],
      ['a currency without an amount', `minimum_order_currency = 'AUD', ${stamp}`],
      ['a zero amount', `minimum_order_amount = 0, minimum_order_currency = 'AUD', ${stamp}`],
      ['a negative amount', `minimum_order_amount = -5, minimum_order_currency = 'AUD', ${stamp}`],
      [
        'a lower-case currency',
        `minimum_order_amount = 5, minimum_order_currency = 'aud', ${stamp}`,
      ],
      [
        'an amount with no change record',
        "minimum_order_amount = 5, minimum_order_currency = 'AUD'",
      ],
      ['a half change record', 'minimum_order_changed_at = now()'],
    ];
    for (const [name, set] of bad) {
      expect([name, await write(sellerId, set).catch((e: { code: string }) => e.code)]).toEqual([
        name,
        '23514',
      ]);
    }
    // The valid pair with its change record is accepted.
    await expect(
      write(sellerId, `minimum_order_amount = 5, minimum_order_currency = 'AUD', ${stamp}`),
    ).resolves.toBeDefined();
  });

  it('reads the approved minimums in one batch: approved sellers only, this Market only', async () => {
    const none = await newSeller(market, true);
    const set = await newSeller(market, true);
    const pending = await newSeller();
    const foreign = await newSeller(other, true);
    await write(
      set,
      `minimum_order_amount = 2500, minimum_order_currency = '${currency}', minimum_order_changed_at = now(), minimum_order_changed_by_account_id = '${ACCOUNT}'`,
    );

    const found = await inUnit(() =>
      profiles.approvedMinimumOrders(market, [
        none,
        set,
        pending,
        foreign,
        randomUUID() as Id<'Seller'>,
      ]),
    );

    expect(found.get(none)).toBeNull();
    expect(found.get(set)).toEqual(money(2500n, currency));
    expect(found.has(pending)).toBe(false);
    expect(found.has(foreign)).toBe(false);
    expect(found.size).toBe(2);
  });

  it('sellerSummaries carries minimumOrder: null, Money, or no key; a stored currency of another Market has no key', async () => {
    const none = await newSeller(market, true);
    const set = await newSeller(market, true);
    const pending = await newSeller();
    const wrong = await newSeller(market, true);
    await write(
      set,
      `minimum_order_amount = 2500, minimum_order_currency = '${currency}', minimum_order_changed_at = now(), minimum_order_changed_by_account_id = '${ACCOUNT}'`,
    );
    await write(
      pending,
      `minimum_order_amount = 2500, minimum_order_currency = '${currency}', minimum_order_changed_at = now(), minimum_order_changed_by_account_id = '${ACCOUNT}'`,
    );
    const foreignCurrency = currency === 'AUD' ? 'JPY' : 'AUD';
    await write(
      wrong,
      `minimum_order_amount = 2500, minimum_order_currency = '${foreignCurrency}', minimum_order_changed_at = now(), minimum_order_changed_by_account_id = '${ACCOUNT}'`,
    );

    const result = await readSellerSummaries(
      { unitOfWork: db.unitOfWork, files, storeProfiles: profiles, minimumOrderPolicy: policy },
      testCallContext(market, 'anonymous'),
      [none, set, pending, wrong],
      { provisionalZone: false },
    );

    expect(result).toEqual({
      ok: true,
      value: [
        { sellerId: none, exists: true, minimumOrder: null },
        { sellerId: set, exists: true, minimumOrder: money(2500n, currency) },
        { sellerId: pending, exists: true },
        { sellerId: wrong, exists: true },
      ],
    });
  });

  describe('the use cases over the real unit of work', () => {
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const counters = new InMemoryCounters();
    const deps = {
      unitOfWork: undefined as never,
      storeProfiles: undefined as never,
      minimumOrderPolicy: policy,
    };
    const contextOf = (sellerId: Id<'Seller'>, m: MarketContext = market) =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'seller',
          accountId: ACCOUNT,
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
    const build = () => {
      const shared = { ...deps, unitOfWork: db.unitOfWork, storeProfiles: profiles };
      return {
        read: new StoreSettingsRead(gate, shared),
        save: new StoreSettingsSaveMinimumOrder(gate, {
          ...shared,
          audit: {
            record: (_context, entry) => {
              audits.push(entry);
              return Promise.resolve();
            },
          },
          counters,
          counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
          clock,
        }),
      };
    };

    it('saves, reads back, refuses a stale version, clears, and audits each change', async () => {
      const sellerId = await newSeller(market, true);
      const { read, save } = build();
      const context = contextOf(sellerId);

      const saved = await save.execute(context, {
        expectedVersion: 1,
        minimumOrder: { amount: 2500, currency },
      });
      expect(saved).toMatchObject({ ok: true, value: { version: 2 } });
      expect(await read.execute(context, {})).toMatchObject({
        ok: true,
        value: { version: 2, minimumOrder: money(2500n, currency) },
      });
      expect(await save.execute(context, { expectedVersion: 1, minimumOrder: null })).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(await save.execute(context, { expectedVersion: 2, minimumOrder: null })).toMatchObject(
        { ok: true, value: { version: 3, minimumOrder: null } },
      );
      expect(audits.map((entry) => [entry.action, entry.after])).toEqual([
        ['sellers.minimum-order.changed', { minimumOrder: money(2500n, currency) }],
        ['sellers.minimum-order.changed', { minimumOrder: null }],
      ]);
    });

    it('refuses a seller without an approved revision and writes nothing', async () => {
      const sellerId = await newSeller();
      const { save } = build();

      const result = await save.execute(contextOf(sellerId), {
        expectedVersion: 1,
        minimumOrder: { amount: 2500, currency },
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await inUnit(() => profiles.find(market, sellerId))).toMatchObject({ version: 1 });
    });

    it('does not reach a seller of another Market', async () => {
      const foreign = await newSeller(other, true);
      const { save } = build();

      const result = await save.execute(contextOf(foreign), {
        expectedVersion: 1,
        minimumOrder: null,
      });

      expect(result).toEqual({ ok: false, error: { code: 'file.not-found' } });
      expect(await inUnit(() => profiles.find(other, foreign), other)).toMatchObject({
        version: 1,
      });
    });

    it('lets exactly one of two concurrent saves win the version', async () => {
      const sellerId = await newSeller(market, true);
      const { save } = build();

      const results = await Promise.all([
        save.execute(contextOf(sellerId), {
          expectedVersion: 1,
          minimumOrder: { amount: 1000, currency },
        }),
        save.execute(contextOf(sellerId), {
          expectedVersion: 1,
          minimumOrder: { amount: 2000, currency },
        }),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, error: { code: 'conflict.stale' } },
      ]);
      expect((await inUnit(() => profiles.find(market, sellerId)))?.version).toBe(2);
    });
  });
});
