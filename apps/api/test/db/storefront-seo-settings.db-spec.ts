import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaSeoSettingsRepository } from '../../src/modules/storefront/infrastructure/prisma-seo-settings.repository';
import {
  DEFAULT_SEO_SETTINGS,
  type SeoSettings,
} from '../../src/modules/storefront/domain/seo-settings';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

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
    expect(await insertRow({ abn: '51824753556' })).toBe('allowed');
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
