import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { Temporal, ok, parseId } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaSeoSettingsRepository } from '../../src/modules/storefront/infrastructure/prisma-seo-settings.repository';
import type { SeoSettings } from '../../src/modules/storefront/domain/seo-settings';
import {
  DEFAULT_SEO_SETTINGS,
  parseSeoSettings,
} from '../../src/modules/storefront/domain/seo-settings';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS, TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../support/test-config';
import type { Persistence } from './persistence-support';
import { createPersistence, marketOf, modelMap, otherMarketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';
import { CheckStorefrontSeoManage } from '../../src/modules/storefront/application/use-cases/check-seo-manage.use-case';
import { SetStorefrontProtectedSeoSettings } from '../../src/modules/storefront/application/use-cases/set-protected-seo-settings.use-case';
import { SetStorefrontSeoSettings } from '../../src/modules/storefront/application/use-cases/set-seo-settings.use-case';
import { ViewStorefrontSeoSettings } from '../../src/modules/storefront/application/use-cases/view-seo-settings.use-case';
import type { SeoDependencies } from '../../src/modules/storefront/application/storefront-dependencies';
import { STOREFRONT_AUDIT_ACTIONS } from '../../src/modules/storefront/domain/audit';
import { STOREFRONT_EVENTS } from '../../src/modules/storefront/domain/events';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { ConsumedStepUp } from '../../src/platform/authz';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { FakeChangeActors } from '../support/change-trail-fakes';
import { dbChangeTrail } from './change-trail-support';
import { ids } from './outbox-support';

// The SEO settings store as the application role, in both Market fixtures: insert-only versions,
// a version taken twice is refused, the value CHECKs, the grants (no update, no delete) and
// never a read across Markets.

const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');
const CHECK = '23514';
const DENIED = '42501';

describe.each(TEST_MARKETS)('storefront SEO settings store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const by = ids.next<'Account'>();
  let db: Persistence;
  let repo: PrismaSeoSettingsRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repo = new PrismaSeoSettingsRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    // Rows of the other Market describe stay in the database; the owner starts both Markets empty.
    const owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    try {
      await owner.query('DELETE FROM storefront.seo_settings WHERE market_id = ANY($1)', [
        [market.marketId, other.marketId],
      ]);
    } finally {
      await owner.end();
    }
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const settings = (patch: Partial<SeoSettings> = {}): SeoSettings => ({
    ...DEFAULT_SEO_SETTINGS,
    ...patch,
  });
  const save = (target: MarketContext, version: number, patch: Partial<SeoSettings> = {}) =>
    value(target, () =>
      repo.append(target, {
        version,
        settings: settings(patch),
        changedAt: T0.add({ minutes: version }),
        changedBy: by,
      }),
    );

  it('answers nothing before the first save', async () => {
    expect(await value(market, () => repo.latest(market))).toBeNull();
    expect(await value(market, () => repo.find(market, 1))).toBeNull();
  });

  it('keeps every version, answers the newest and an older one, and refuses a taken version', async () => {
    expect(await save(market, 1, { siteName: 'First' })).toBe(true);
    expect(
      await save(market, 2, {
        indexing: 'on',
        abn: '51824753556',
        postalAddress: {
          street: '1 Main St',
          city: 'Brisbane',
          state: 'QLD',
          postcode: '4000',
          country: 'AU',
        },
        sameAs: ['https://example.com/a'],
      }),
    ).toBe(true);
    expect(await save(market, 2, { siteName: 'Taken' })).toBe(false);
    const latest = await value(market, () => repo.latest(market));
    expect(latest?.version).toBe(2);
    expect(latest?.settings).toMatchObject({
      indexing: 'on',
      abn: '51824753556',
      sameAs: ['https://example.com/a'],
      postalAddress: { city: 'Brisbane' },
    });
    expect((await value(market, () => repo.find(market, 1)))?.settings.siteName).toBe('First');
  });

  it('never reads or counts across Markets', async () => {
    expect(await value(other, () => repo.latest(other))).toBeNull();
    expect(await value(other, () => repo.find(other, 1))).toBeNull();
    expect(await save(other, 1, { siteName: 'Elsewhere' })).toBe(true);
    expect((await value(market, () => repo.find(market, 1)))?.settings.siteName).toBe('First');
  });

  it('refuses a value the API would refuse (the CHECKs)', async () => {
    const insertRow = (overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        market_id: code,
        version: 90,
        tenant_id: market.tenantId,
        indexing: 'off',
        site_name: 'Shop',
        title_template: '{title} | {site}',
        default_description: 'x'.repeat(60),
        seller_pages: 'none',
        page_templates: JSON.stringify({
          home: {},
          category: {},
          product: {},
          seller: {},
          sellers: {},
          landing: {},
        }),
        changed_at: T0.toString(),
        changed_by: by,
        ...overrides,
      };
      const keys = Object.keys(row);
      const marks = keys.map((_, i) => `$${i + 1}`).join(', ');
      return sql
        .query(
          `INSERT INTO storefront.seo_settings (${keys.join(', ')}) VALUES (${marks}) ON CONFLICT DO NOTHING`,
          Object.values(row),
        )
        .then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );
    };
    expect(await insertRow({ abn: '12345678901' })).toBe(CHECK);
    expect(await insertRow({ site_name: '<b>x</b>' })).toBe(CHECK);
    expect(await insertRow({ title_template: 'no placeholder' })).toBe(CHECK);
    expect(await insertRow({ same_as: ['http://example.com'] })).toBe(CHECK);
    expect(await insertRow({ analytics_id: 'UA-1' })).toBe(CHECK);
    expect(await insertRow({ indexing: 'yes' })).toBe(CHECK);
    expect(await insertRow({ version: 0 })).toBe(CHECK);
    expect(await insertRow({ same_as: [`https://x.com/${'a'.repeat(190)}`] })).toBe(CHECK);
    expect(await insertRow({ same_as: ['https://a.com', null] })).toBe(CHECK);
    expect(await insertRow({ same_as: null })).toBe(CHECK);
    expect(await insertRow({ abn: '51824753556' })).toBe('allowed');
  });

  it('stores what the API accepts at its largest bounds (the database never stricter)', async () => {
    const zwnj = '\u200C';
    const text = (n: number) => `می${zwnj}`.repeat(n).slice(0, n);
    const template = { title: text(120), description: text(160) };
    const parsed = parseSeoSettings({
      ...DEFAULT_SEO_SETTINGS,
      siteName: text(60),
      titleTemplate: `{title} ${text(30)}`.slice(0, 40),
      defaultDescription: text(160),
      tradingName: text(100),
      legalName: text(150),
      postalAddress: {
        street: text(100),
        city: text(60),
        state: text(30),
        postcode: '4000 4000',
        country: 'AU',
      },
      contactEmail: `${'a'.repeat(64)}@${'b'.repeat(60)}.example.com`,
      contactPhone: '+61412345678',
      sameAs: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}/${'a'.repeat(150)}`),
      pageTemplates: Object.fromEntries(
        ['home', 'category', 'product', 'seller', 'sellers', 'landing'].map((k) => [k, template]),
      ),
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(await save(market, 70, parsed.value)).toBe(true);
    const back = await value(market, () => repo.find(market, 70));
    expect(back?.settings).toEqual(parsed.value);
  });

  it('gives the application role no update and no delete', async () => {
    await sql.query('BEGIN');
    try {
      await sql.query('SET LOCAL ROLE mondapac_app');
      const update = await sql
        .query(`UPDATE storefront.seo_settings SET site_name = 'x' WHERE market_id = $1`, [code])
        .then(
          () => 'allowed',
          (e: { code?: string }) => e.code,
        );
      expect(update).toBe(DENIED);
    } finally {
      await sql.query('ROLLBACK');
    }
    await sql.query('BEGIN');
    try {
      await sql.query('SET LOCAL ROLE mondapac_app');
      const del = await sql
        .query(`DELETE FROM storefront.seo_settings WHERE market_id = $1`, [code])
        .then(
          () => 'allowed',
          (e: { code?: string }) => e.code,
        );
      expect(del).toBe(DENIED);
    } finally {
      await sql.query('ROLLBACK');
    }
  });
});

{
  // The SEO settings use cases on the real unit of work: the version, its audit row and (when the
  // indexing value moves) its outbox row commit together, and a failure after the insert leaves
  // none of the three. Both Market fixtures; never across Markets.

  const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const id = <T extends string>(n: number): Id<T> => {
    const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
    if (!parsed.ok) throw new Error('bad id');
    return parsed.value as Id<T>;
  };
  const ADMIN = id<'Account'>(0x5e0);

  describe.each(TEST_MARKETS)('storefront SEO settings flow in market %s (database)', (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const clock = new FixedClock(T0);
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const actors = new FakeChangeActors();
    let db: Persistence;
    let audit: AuditWriter;
    let catalogue: AuditActionCatalogue;
    let failAudit = false;
    let deps: SeoDependencies;
    let sql: Client;

    beforeAll(async () => {
      db = createPersistence();
      catalogue = new AuditActionCatalogue();
      catalogue.register('storefront', STOREFRONT_AUDIT_ACTIONS);
      catalogue.seal();
      const real = PersistenceModule.auditWriterFor('storefront').useFactory(
        catalogue,
        ids,
        { now: () => Temporal.Now.instant() },
        NO_PERMISSION_KEYS,
      ) as AuditWriter;
      // Fails after the version row is inserted, to prove the unit rolls everything back.
      audit = {
        record: (context, entry) =>
          failAudit ? Promise.reject(new Error('audit down')) : real.record(context, entry),
      };
      const events = new EventCatalogue();
      events.register('storefront', STOREFRONT_EVENTS);
      events.seal();
      const outbox = new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        events,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('storefront');
      deps = {
        unitOfWork: db.unitOfWork,
        audit,
        clock,
        seoSettings: new PrismaSeoSettingsRepository(db.service),
        seoEnvironment: { ceiling: () => 'on', sampleDataLock: () => false },
        trail: dbChangeTrail('storefront', catalogue, db.unitOfWork, actors),
        outbox,
        stepUp: {
          consume: (context: CallContext) =>
            Promise.resolve(
              ok<ConsumedStepUp>({
                sessionId: (context.actor as { sessionId: Id<'Session'> }).sessionId,
                verifiedAt: T0,
              }),
            ),
        },
        seoManageProbe: new CheckStorefrontSeoManage(gate),
      };
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    });
    afterAll(async () => {
      await db.close();
      await sql.end();
    });

    const admin = (target: MarketContext) =>
      testCallContext(
        target,
        testAuthenticatedActor(target, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: id<'Session'>(0x5e1),
          sellerId: null,
        }),
        'seo-db-abcd',
      );
    const versionOf = async (target: MarketContext) => {
      const read = await new ViewStorefrontSeoSettings(gate, deps).execute(admin(target), {});
      if (!read.ok) throw new Error(read.error.code);
      return read.value.version;
    };
    const count = async (sqlText: string, target: MarketContext) =>
      Number(((await sql.query(sqlText, [target.marketId])).rows[0] as { n: string }).n);
    const versionRows = (target: MarketContext) =>
      count('SELECT count(*) AS n FROM storefront.seo_settings WHERE market_id = $1', target);
    const auditRows = (target: MarketContext) =>
      count(
        `SELECT count(*) AS n FROM platform.audit_log
        WHERE market_id = $1 AND action = 'storefront.seo-settings.changed'`,
        target,
      );
    const eventRows = (target: MarketContext) =>
      count(
        `SELECT count(*) AS n FROM storefront.outbox
        WHERE market_id = $1 AND type = 'storefront.seo-indexing-changed.v1'`,
        target,
      );

    const editPart = (siteName: string) => ({
      siteName,
      titleTemplate: DEFAULT_SEO_SETTINGS.titleTemplate,
      defaultDescription: DEFAULT_SEO_SETTINGS.defaultDescription,
      defaultShareImage: null,
      sellerPages: DEFAULT_SEO_SETTINGS.sellerPages,
      sameAs: [],
      pageTemplates: DEFAULT_SEO_SETTINGS.pageTemplates,
    });
    const protectedPart = (indexing: 'on' | 'off') => ({
      indexing,
      logo: null,
      tradingName: null,
      legalName: null,
      abn: null,
      postalAddress: null,
      contactEmail: null,
      contactPhone: null,
      googleVerification: null,
      bingVerification: null,
      analyticsId: null,
    });

    it('commits the version and its audit row together, and the event only when indexing moves', async () => {
      const otherBefore = await versionOf(other);
      const from = await versionOf(market);
      const [versions, audits, events] = [
        await versionRows(market),
        await auditRows(market),
        await eventRows(market),
      ];

      const edit = await new SetStorefrontSeoSettings(gate, deps).execute(admin(market), {
        settings: editPart(`Shop ${from}`),
        expectedVersion: from,
      });
      expect(edit.ok && edit.value.version).toBe(from + 1);
      expect(await versionRows(market)).toBe(versions + 1);
      expect(await auditRows(market)).toBe(audits + 1);
      expect(await eventRows(market)).toBe(events);

      const moved = await new SetStorefrontProtectedSeoSettings(gate, deps).execute(admin(market), {
        settings: protectedPart('on'),
        expectedVersion: from + 1,
      });
      expect(moved.ok && moved.value.version).toBe(from + 2);
      expect(await auditRows(market)).toBe(audits + 2);
      expect(await eventRows(market)).toBe(events + 1);

      // The same indexing value again moves nothing: a new version and audit row, no event.
      const same = await new SetStorefrontProtectedSeoSettings(gate, deps).execute(admin(market), {
        settings: { ...protectedPart('on'), tradingName: 'Trade Co' },
        expectedVersion: from + 2,
      });
      expect(same.ok && same.value.version).toBe(from + 3);
      expect(await eventRows(market)).toBe(events + 1);

      expect(await versionOf(other)).toBe(otherBefore);
    });

    it('leaves no version, audit row or event when the unit fails after the insert', async () => {
      const from = await versionOf(market);
      const before = [await versionRows(market), await auditRows(market), await eventRows(market)];
      failAudit = true;
      try {
        await expect(
          new SetStorefrontProtectedSeoSettings(gate, deps).execute(admin(market), {
            settings: protectedPart(from % 2 === 0 ? 'on' : 'off'),
            expectedVersion: from,
          }),
        ).rejects.toThrow('audit down');
      } finally {
        failAudit = false;
      }
      expect([await versionRows(market), await auditRows(market), await eventRows(market)]).toEqual(
        before,
      );
      expect(await versionOf(market)).toBe(from);
    });

    it('refuses a stale version without writing anything', async () => {
      const from = await versionOf(market);
      const before = [await versionRows(market), await auditRows(market)];
      const stale = await new SetStorefrontSeoSettings(gate, deps).execute(admin(market), {
        settings: editPart('Stale'),
        expectedVersion: from - 1,
      });
      expect(stale.ok).toBe(false);
      expect(!stale.ok && stale.error.code).toBe('storefront.conflict');
      expect([await versionRows(market), await auditRows(market)]).toEqual(before);
    });
  });
}
