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
import { StoreSettingsRead } from '../../src/modules/sellers/application/use-cases/store-settings-read.use-case';
import { StoreSettingsSaveDelivery } from '../../src/modules/sellers/application/use-cases/store-settings-save-delivery.use-case';
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

// The seller's delivery terms on PostgreSQL (package e), for both Market fixtures, as the application role: the six
// columns and their CHECKs, the optimistic version, the approved-only batch read behind the public store
// pages, and the save use case end to end over the real unit of work. Model: sellers-minimum-order.db-spec.ts.

const T0 = Temporal.Instant.from('2026-10-21T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigMinimumOrderPolicy(markets);
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(TEST_MARKETS)('the seller delivery terms in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
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

  const write = (sellerId: Id<'Seller'>, set: string) =>
    sql.query(`UPDATE sellers.store_profiles SET ${set} WHERE market_id = $1 AND seller_id = $2`, [
      market.marketId,
      sellerId,
    ]);

  const TERMS = { day: 'next-day', fromMinute: 480, toMinute: 720, cutoffMinute: 840 } as const;
  type Terms = {
    day: 'same-day' | 'next-day';
    fromMinute: number;
    toMinute: number;
    cutoffMinute: number;
  };
  const stamp = `delivery_changed_at = now(), delivery_changed_by_account_id = '${ACCOUNT}'`;

  const change = (sellerId: Id<'Seller'>, expectedVersion: number, delivery: Terms | null) =>
    inUnit(
      () =>
        profiles.saveDeliveryTerms(market, sellerId, {
          expectedVersion,
          delivery,
          changedByAccountId: ACCOUNT,
          changedAt: T0,
        }),
      market,
      false,
    );

  it('a created store profile reads no terms at version 1', async () => {
    const sellerId = await newSeller(market, true);

    expect(await inUnit(() => profiles.find(market, sellerId))).toEqual({
      version: 1,
      approved: true,
      minimumOrder: null,
      delivery: null,
    });
  });

  it('sets, reads back and clears the terms under the version, and raises it each time', async () => {
    const sellerId = await newSeller(market, true);

    expect(await change(sellerId, 1, TERMS)).toBe(2);
    expect(await inUnit(() => profiles.find(market, sellerId))).toMatchObject({
      version: 2,
      delivery: TERMS,
    });
    // A stale version writes nothing.
    expect(await change(sellerId, 1, { ...TERMS, day: 'next-day', cutoffMinute: 900 })).toBeNull();
    expect(await change(sellerId, 2, null)).toBe(3);
    expect(await inUnit(() => profiles.find(market, sellerId))).toMatchObject({
      version: 3,
      delivery: null,
    });
    const row = await sql.query(
      'SELECT delivery_changed_by_account_id AS who FROM sellers.store_profiles WHERE seller_id = $1',
      [sellerId],
    );
    expect((row.rows[0] as { who: string }).who).toBe(ACCOUNT);
  });

  it('keeps the minimum order when the terms change, and the terms when the minimum changes', async () => {
    const sellerId = await newSeller(market, true);
    await write(
      sellerId,
      `minimum_order_amount = 2500, minimum_order_currency = 'AUD', minimum_order_changed_at = now(), minimum_order_changed_by_account_id = '${ACCOUNT}'`,
    );

    await change(sellerId, 1, TERMS);

    expect(await inUnit(() => profiles.find(market, sellerId))).toMatchObject({
      minimumOrder: money(2500n, 'AUD'),
      delivery: TERMS,
    });
  });

  it('refuses rows the CHECKs forbid, and accepts the valid ones', async () => {
    const sellerId = await newSeller(market, true);
    const all = (override: Record<string, string>) => {
      const v = {
        delivery_day: "'next-day'",
        delivery_from_minute: '480',
        delivery_to_minute: '720',
        order_cutoff_minute: '840',
        ...override,
      };
      return `${Object.entries(v)
        .map(([k, x]) => `${k} = ${x}`)
        .join(', ')}, ${stamp}`;
    };
    const bad: [string, string][] = [
      ['a day alone', "delivery_day = 'next-day'"],
      [
        'three of four terms',
        `delivery_day = 'next-day', delivery_from_minute = 480, delivery_to_minute = 720, ${stamp}`,
      ],
      ['an unknown day', all({ delivery_day: "'weekly'" })],
      ['a window that closes before it opens', all({ delivery_from_minute: '780' })],
      ['a window that closes when it opens', all({ delivery_from_minute: '720' })],
      [
        'a window that opens at the end of the day',
        all({ delivery_from_minute: '1440', delivery_to_minute: '1440' }),
      ],
      ['a window that ends after the day', all({ delivery_to_minute: '1470' })],
      ['a window start that is not a half hour', all({ delivery_from_minute: '485' })],
      ['a window end that is not a half hour', all({ delivery_to_minute: '725' })],
      ['a cut-off that is not a half hour', all({ order_cutoff_minute: '845' })],
      ['a cut-off at the end of the day', all({ order_cutoff_minute: '1440' })],
      ['a negative cut-off', all({ order_cutoff_minute: '-30' })],
      ['a same-day cut-off after the window closes', all({ delivery_day: "'same-day'" })],
      [
        'a same-day cut-off at the window close',
        all({ delivery_day: "'same-day'", order_cutoff_minute: '720' }),
      ],
      [
        'terms with no change record',
        "delivery_day = 'next-day', delivery_from_minute = 480, delivery_to_minute = 720, order_cutoff_minute = 840",
      ],
      ['a half change record', 'delivery_changed_at = now()'],
    ];
    for (const [name, set] of bad) {
      expect([name, await write(sellerId, set).catch((e: { code: string }) => e.code)]).toEqual([
        name,
        '23514',
      ]);
    }
    await expect(write(sellerId, all({}))).resolves.toBeDefined();
    await expect(
      write(sellerId, all({ delivery_day: "'same-day'", order_cutoff_minute: '690' })),
    ).resolves.toBeDefined();
    await expect(
      write(sellerId, all({ delivery_from_minute: '1020', delivery_to_minute: '1440' })),
    ).resolves.toBeDefined();
  });

  it('reads the approved terms in one batch: approved sellers with terms only, this Market only', async () => {
    const none = await newSeller(market, true);
    const set = await newSeller(market, true);
    const pending = await newSeller();
    const foreign = await newSeller(other, true);
    await change(set, 1, TERMS);
    await write(
      pending,
      `delivery_day = 'next-day', delivery_from_minute = 480, delivery_to_minute = 720, order_cutoff_minute = 840, ${stamp}`,
    );

    const found = await inUnit(() =>
      profiles.approvedDeliveryTerms(market, [
        none,
        set,
        pending,
        foreign,
        randomUUID() as Id<'Seller'>,
      ]),
    );

    expect([...found]).toEqual([[set, TERMS]]);
  });

  it('refuses a batch of more than 100 ids', async () => {
    const batch = Array.from({ length: 101 }, () => randomUUID() as Id<'Seller'>);

    await expect(inUnit(() => profiles.approvedDeliveryTerms(market, batch))).rejects.toThrow(
      RangeError,
    );
  });

  describe('the use cases over the real unit of work', () => {
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const counters = new InMemoryCounters();
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
      const shared = {
        unitOfWork: db.unitOfWork,
        storeProfiles: profiles,
        minimumOrderPolicy: policy,
      };
      return {
        read: new StoreSettingsRead(gate, shared),
        save: new StoreSettingsSaveDelivery(gate, {
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
    const terms = { day: 'same-day', from: '09:00', to: '24:00', cutoff: '08:30' };

    it('saves, reads back, refuses a stale version, clears, and audits each change', async () => {
      const sellerId = await newSeller(market, true);
      const { read, save } = build();
      const context = contextOf(sellerId);

      const saved = await save.execute(context, { expectedVersion: 1, delivery: terms });
      expect(saved).toMatchObject({
        ok: true,
        value: {
          version: 2,
          delivery: { day: 'same-day', fromMinute: 540, toMinute: 1440, cutoffMinute: 510 },
        },
      });
      expect(await read.execute(context, {})).toMatchObject({
        ok: true,
        value: { version: 2, delivery: { toMinute: 1440 } },
      });
      expect(await save.execute(context, { expectedVersion: 1, delivery: null })).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(await save.execute(context, { expectedVersion: 2, delivery: null })).toMatchObject({
        ok: true,
        value: { version: 3, delivery: null },
      });
      expect(audits.map((entry) => [entry.action, entry.after])).toEqual([
        [
          'sellers.delivery-terms.changed',
          { day: 'same-day', fromMinute: 540, toMinute: 1440, cutoffMinute: 510 },
        ],
        [
          'sellers.delivery-terms.changed',
          { day: null, fromMinute: null, toMinute: null, cutoffMinute: null },
        ],
      ]);
    });

    it('refuses a seller without an approved revision and writes nothing', async () => {
      const sellerId = await newSeller();
      const { save } = build();

      const result = await save.execute(contextOf(sellerId), {
        expectedVersion: 1,
        delivery: terms,
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await inUnit(() => profiles.find(market, sellerId))).toMatchObject({
        version: 1,
        delivery: null,
      });
    });

    it('does not reach a seller of another Market', async () => {
      const foreign = await newSeller(other, true);
      const { save } = build();

      const result = await save.execute(contextOf(foreign), { expectedVersion: 1, delivery: null });

      expect(result).toEqual({ ok: false, error: { code: 'file.not-found' } });
    });

    it('lets exactly one of two concurrent saves win the version', async () => {
      const sellerId = await newSeller(market, true);
      const { save } = build();

      const results = await Promise.all([
        save.execute(contextOf(sellerId), { expectedVersion: 1, delivery: terms }),
        save.execute(contextOf(sellerId), {
          expectedVersion: 1,
          delivery: { ...terms, cutoff: '09:00' },
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
