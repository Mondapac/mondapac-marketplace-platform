import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { BusinessActivityState } from '../../src/modules/catalog/domain/business-activity';
import { PrismaBusinessActivityReader } from '../../src/modules/catalog/infrastructure/prisma-business-activity.reader';
import { PrismaBusinessActivityRepository } from '../../src/modules/catalog/infrastructure/prisma-business-activity.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { sqlState } from './sql-state';
import { testDatabaseUrl } from './test-database';

// The catalog business-activity package on PostgreSQL, for both Market fixtures: the constraints of
// the three tables, the repository (names and links replaced as a set, unique code and name per
// Market, optimistic version), the reader (search in any locale, keyset paging) and Market
// isolation. Each case builds its own activities under a code nobody else uses.

const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-31T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const tag = (): string => randomUUID().replaceAll('-', '').slice(0, 10);
const letters = (value: string): string =>
  value.replace(/[0-9]/g, (digit) => 'abcdefghij'[Number(digit)]!);

describe.each(TEST_MARKETS)(
  'catalog business activities in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let persistence: Persistence;
    let repository: PrismaBusinessActivityRepository;
    let reader: PrismaBusinessActivityReader;
    let sql: Client;

    beforeAll(async () => {
      persistence = createPersistence();
      repository = new PrismaBusinessActivityRepository(persistence.service);
      reader = new PrismaBusinessActivityReader(persistence.service);
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await sql.end();
      await persistence.close();
    });

    const inUnitOf =
      (target: typeof market) =>
      <T>(work: () => Promise<T>): Promise<T> =>
        persistence.unitOfWork
          .run(target, async () => ({ ok: true as const, value: await work() }))
          .then((result) => {
            if (!result.ok) throw new Error('unit failed');
            return result.value;
          });
    const inUnit = inUnitOf(market);

    async function insertCategory(target = market): Promise<Id<'Category'>> {
      const id = uuid7();
      await sql.query(
        `INSERT INTO catalog.platform_categories
           (id, market_id, tenant_id, slug, status, created_by_kind, version, created_at)
         VALUES ($1, $2, $3, $4, 'active', 'seed', 1, $5)`,
        [id, target.marketId, target.tenantId, `ba-${tag()}`, T0.toString()],
      );
      return id as Id<'Category'>;
    }

    function activity(
      unique: string,
      overrides: Partial<BusinessActivityState> = {},
    ): BusinessActivityState {
      return {
        id: uuid7() as Id<'BusinessActivity'>,
        code: `act-${unique}`,
        status: 'active',
        description: null,
        names: [{ locale: 'en', name: `Activity ${unique}` }],
        categoryIds: [],
        createdBy: uuid7() as Id<'Account'>,
        createdAt: T0,
        updatedAt: T0,
        version: 1,
        ...overrides,
      };
    }

    it('stores an activity with its names and links and reads it back', async () => {
      const unique = letters(tag());
      const category = await insertCategory();
      const state = activity(unique, {
        description: 'Meat counter',
        names: [
          { locale: 'ar', name: `جزار ${unique}` },
          { locale: 'en', name: `Butcher ${unique}` },
        ],
        categoryIds: [category],
      });

      expect(await inUnit(() => repository.add(market, state))).toBeNull();
      const found = await inUnit(() => repository.findById(market, state.id));

      expect(found).toEqual(state);
      expect(await inUnit(() => repository.codeTaken(market, state.code))).toBe(true);
      expect(await inUnit(() => repository.codeTaken(market, `${state.code}-x`))).toBe(false);
    });

    it('keeps an activity inside its Market', async () => {
      const state = activity(letters(tag()));
      await inUnit(() => repository.add(market, state));

      expect(await inUnitOf(other)(() => repository.findById(other, state.id))).toBeNull();
      expect(await inUnitOf(other)(() => repository.codeTaken(other, state.code))).toBe(false);
    });

    it('lets the other Market reuse a code and a name, but not this Market', async () => {
      const unique = letters(tag());
      expect(await inUnit(() => repository.add(market, activity(unique)))).toBeNull();

      expect(await inUnit(() => repository.add(market, activity(unique)))).toBe(
        'business-activity.code-taken',
      );
      expect(
        await inUnit(() =>
          repository.add(
            market,
            activity(`${unique}b`, { names: [{ locale: 'en', name: `ACTIVITY ${unique}` }] }),
          ),
        ),
      ).toBe('business-activity.name-taken');
      expect(await inUnitOf(other)(() => repository.add(other, activity(unique)))).toBeNull();
    });

    it('replaces names and links as a set under the version it was read at', async () => {
      const unique = letters(tag());
      const [first, second] = [await insertCategory(), await insertCategory()];
      const state = activity(unique, { categoryIds: [first] });
      await inUnit(() => repository.add(market, state));

      const edited: BusinessActivityState = {
        ...state,
        status: 'inactive',
        description: 'Changed',
        names: [{ locale: 'en', name: `Renamed ${unique}` }],
        categoryIds: [second],
        updatedAt: T1,
        version: 2,
      };
      expect(await inUnit(() => repository.save(market, edited, 1))).toBeNull();

      expect(await inUnit(() => repository.findById(market, state.id))).toEqual(edited);
      await expect(
        inUnit(() => repository.save(market, { ...edited, version: 3 }, 1)),
      ).rejects.toBeInstanceOf(StaleAggregateError);
    });

    it('refuses a link to a category of another Market or to none', async () => {
      const foreign = await insertCategory(other);
      const state = activity(letters(tag()), { categoryIds: [foreign] });

      await expect(inUnit(() => repository.add(market, state))).rejects.toThrow();
      const missing = activity(letters(tag()), { categoryIds: [uuid7() as Id<'Category'>] });
      await expect(inUnit(() => repository.add(market, missing))).rejects.toThrow();
    });

    it('lists by code with keyset paging, a status filter and a search in any locale', async () => {
      const unique = letters(tag());
      const states = ['a', 'b', 'c'].map((suffix) =>
        activity(`${unique}-${suffix}`, {
          status: suffix === 'b' ? 'inactive' : 'active',
          names: [
            { locale: 'ar', name: `بقالة ${unique}${suffix}` },
            { locale: 'en', name: `Shop ${unique}${suffix}` },
          ],
        }),
      );
      for (const state of states) await inUnit(() => repository.add(market, state));

      const page1 = await inUnit(() =>
        reader.list(market, { status: null, search: unique, afterId: null, limit: 2 }),
      );
      expect(page1.items.map((i) => i.code)).toEqual([states[0]!.code, states[1]!.code]);
      expect(page1.nextAfterId).toBe(states[1]!.id);
      const page2 = await inUnit(() =>
        reader.list(market, { status: null, search: unique, afterId: page1.nextAfterId, limit: 2 }),
      );
      expect(page2.items.map((i) => i.code)).toEqual([states[2]!.code]);
      expect(page2.nextAfterId).toBeNull();

      const inactive = await inUnit(() =>
        reader.list(market, { status: 'inactive', search: unique, afterId: null, limit: 10 }),
      );
      expect(inactive.items.map((i) => i.id)).toEqual([states[1]!.id]);
      const arabic = await inUnit(() =>
        reader.list(market, { status: null, search: 'بقالة', afterId: null, limit: 100 }),
      );
      expect(arabic.items.some((i) => i.id === states[0]!.id)).toBe(true);
      const foreign = await inUnitOf(other)(() =>
        reader.list(other, { status: null, search: unique, afterId: null, limit: 10 }),
      );
      expect(foreign.items).toEqual([]);
    });

    it('enforces the CHECKs of the three tables', async () => {
      const insertActivity = (overrides: Record<string, unknown>) => {
        const row = {
          id: uuid7(),
          market_id: market.marketId,
          tenant_id: market.tenantId,
          code: `chk-${letters(tag())}`,
          status: 'active',
          created_by: uuid7(),
          created_at: T0.toString(),
          updated_at: T0.toString(),
          version: 1,
          ...overrides,
        };
        const columns = Object.keys(row);
        return sqlState(
          sql,
          `INSERT INTO catalog.business_activities (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
      };

      expect(await insertActivity({ code: 'Bad Code' })).toBe('23514');
      expect(await insertActivity({ status: 'deleted' })).toBe('23514');
      expect(await insertActivity({ version: 0 })).toBe('23514');
      expect(await insertActivity({ description: ' padded ' })).toBe('23514');
      expect(await insertActivity({ description: 'x'.repeat(301) })).toBe('23514');
      expect(await insertActivity({ tenant_id: 'BAD' })).toBe('23514');

      const state = activity(letters(tag()));
      await inUnit(() => repository.add(market, state));
      const insertName = (locale: string, name: string) =>
        sqlState(
          sql,
          `INSERT INTO catalog.business_activity_names (market_id, tenant_id, activity_id, locale, name)
           VALUES ($1, $2, $3, $4, $5)`,
          [market.marketId, market.tenantId, state.id, locale, name],
        );
      expect(await insertName('EN!', 'Name')).toBe('23514');
      expect(await insertName('fr', ' Padded ')).toBe('23514');
      expect(await insertName('fr', '')).toBe('23514');
    });

    it('never lets the application change a code or a creator', async () => {
      const state = activity(letters(tag()));
      await inUnit(() => repository.add(market, state));

      expect(
        await sqlState(sql, 'UPDATE catalog.business_activities SET code = $2 WHERE id = $1', [
          state.id,
          'renamed',
        ]),
      ).toBe('42501');
      expect(
        await sqlState(
          sql,
          'UPDATE catalog.business_activities SET created_by = $2 WHERE id = $1',
          [state.id, uuid7()],
        ),
      ).toBe('42501');
    });
  },
);
