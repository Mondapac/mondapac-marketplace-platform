import { randomUUID } from 'node:crypto';
import { Temporal, ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaServiceAreaNamesRepository } from '../../src/modules/sellers/infrastructure/prisma-service-area-names.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Edited service area names (ADR-0041) on PostgreSQL, for both Market fixtures, as the application
// role: set, change, restore (delete), the Market scope, the CHECKs and the column grants.

const CHECK = '23514';
const UNIQUE = '23505';
const DENIED = '42501';
const AT = Temporal.Instant.from('2026-11-04T10:00:00Z');

describe.each(TEST_MARKETS)('service area names in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const by = randomUUID() as Id<'Account'>;
  let db: Persistence;
  let sql: Client;
  let repository: PrismaServiceAreaNamesRepository;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: testDatabaseUrl() });
    repository = new PrismaServiceAreaNamesRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.query('DELETE FROM sellers.service_area_names WHERE area_code LIKE $1', ['t-%']);
    await sql.end();
    await db.close();
  });

  const area = () => `t-${randomUUID().slice(0, 8)}`;
  const apply = async (
    m: typeof market,
    areaCode: string,
    changes: Record<string, string | null>,
  ) => {
    const done = await db.unitOfWork.run(m, async () =>
      ok(await repository.apply(m, areaCode, new Map(Object.entries(changes)), by, AT)),
    );
    if (!done.ok) throw new Error('unreachable');
    return done.value;
  };
  const read = async (m: typeof market) => {
    const rows = await db.unitOfWork.run(m, async () => ok(await repository.all(m)), {
      readOnly: true,
    });
    if (!rows.ok) throw new Error('unreachable');
    return rows.value;
  };
  const errorCode = (work: Promise<unknown>) =>
    work.then(
      () => 'allowed',
      (error: { code?: string }) => error.code ?? 'no-code',
    );
  const insert = (areaCode: string, locale: string, name: string, marketId = market.marketId) =>
    sql.query(
      `INSERT INTO sellers.service_area_names (market_id, tenant_id, area_code, locale, name, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [marketId, market.tenantId, areaCode, locale, name, by],
    );

  it('sets, changes and restores names, and counts only real changes', async () => {
    const a = area();
    expect(await apply(market, a, { en: 'One', fa: 'یک' })).toEqual({ set: 2, restored: 0 });
    expect(await apply(market, a, { en: 'One' })).toEqual({ set: 0, restored: 0 });
    expect(await apply(market, a, { en: 'Two' })).toEqual({ set: 1, restored: 0 });
    expect((await read(market)).filter((r) => r.areaCode === a)).toEqual([
      { areaCode: a, locale: 'en', name: 'Two' },
      { areaCode: a, locale: 'fa', name: 'یک' },
    ]);
    expect(await apply(market, a, { en: null, ar: null })).toEqual({ set: 0, restored: 1 });
    expect((await read(market)).filter((r) => r.areaCode === a).map((r) => r.locale)).toEqual([
      'fa',
    ]);
  });

  it('keeps a Market to its own names', async () => {
    const a = area();
    await apply(market, a, { en: 'Mine' });
    expect((await read(other)).some((r) => r.areaCode === a)).toBe(false);
    await apply(other, a, { en: 'Theirs' });
    expect((await read(market)).find((r) => r.areaCode === a)?.name).toBe('Mine');
    await apply(other, a, { en: null });
  });

  it('refuses a second row for the same area and language, and malformed values', async () => {
    const a = area();
    await insert(a, 'en', 'One');
    expect(await errorCode(insert(a, 'en', 'Again'))).toBe(UNIQUE);
    expect(await errorCode(insert(area(), 'en', ' padded '))).toBe(CHECK);
    expect(await errorCode(insert(area(), 'en', ''))).toBe(CHECK);
    expect(await errorCode(insert(area(), 'en', 'x'.repeat(121)))).toBe(CHECK);
    expect(await errorCode(insert(area(), 'EN', 'Name'))).toBe(CHECK);
    expect(await errorCode(insert('Bad Code', 'en', 'Name'))).toBe(CHECK);
    expect(await errorCode(insert(area(), 'en', 'Tab\there'))).toBe(CHECK);
    expect(await errorCode(insert(area(), 'en', 'Name', 'lower' as typeof market.marketId))).toBe(
      CHECK,
    );
  });

  it('lets the application role change the name only, never the key', async () => {
    const a = area();
    await insert(a, 'en', 'One');
    expect(
      await errorCode(
        sql.query(
          'UPDATE sellers.service_area_names SET name = $3 WHERE market_id = $1 AND area_code = $2',
          [market.marketId, a, 'Two'],
        ),
      ),
    ).toBe('allowed');
    expect(
      await errorCode(
        sql.query(
          'UPDATE sellers.service_area_names SET area_code = $3 WHERE market_id = $1 AND area_code = $2',
          [market.marketId, a, area()],
        ),
      ),
    ).toBe(DENIED);
  });
});
