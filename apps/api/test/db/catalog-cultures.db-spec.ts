import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { CultureState } from '../../src/modules/catalog/domain/culture';
import { PrismaCultureReader } from '../../src/modules/catalog/infrastructure/prisma-culture.reader';
import { PrismaCultureRepository } from '../../src/modules/catalog/infrastructure/prisma-culture.repository';
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

// Multi-culture package 1 on PostgreSQL, for both Market fixtures: the constraints of the three
// tables, the repository (names replaced as a set, unique code and name per Market, one default per
// Market, optimistic version, mark rows) and the reader (order, filters, search in any locale), and
// Market isolation. Each case builds its own cultures under a code nobody else uses.

const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-11T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const tag = (): string => randomUUID().replaceAll('-', '').slice(0, 10);
const letters = (value: string): string =>
  value.replace(/[0-9]/g, (digit) => 'abcdefghij'[Number(digit)]!);

describe.each(TEST_MARKETS)('catalog cultures in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let repository: PrismaCultureRepository;
  let reader: PrismaCultureReader;
  let sql: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    repository = new PrismaCultureRepository(persistence.service);
    reader = new PrismaCultureReader(persistence.service);
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
      [id, target.marketId, target.tenantId, `cu-${tag()}`, T0.toString()],
    );
    return id as Id<'Category'>;
  }

  function culture(unique: string, overrides: Partial<CultureState> = {}): CultureState {
    return {
      id: uuid7() as Id<'Culture'>,
      code: `cul-${unique}`,
      status: 'draft',
      displayOrder: 5,
      requiredCertificationType: null,
      badgeColour: null,
      isDefault: false,
      names: [{ locale: 'en', name: `Culture ${unique}`, description: 'About it' }],
      createdBy: uuid7() as Id<'Account'>,
      createdAt: T0,
      updatedAt: T0,
      version: 1,
      ...overrides,
    };
  }

  it('stores a culture with its names and reads it back, also a seeded one with no creator', async () => {
    const unique = letters(tag());
    const state = culture(unique, {
      requiredCertificationType: 'halal',
      badgeColour: 'accent',
      names: [
        { locale: 'ar', name: `ثقافة ${unique}`, description: null },
        { locale: 'en', name: `Muslim ${unique}`, description: 'Shown to buyers' },
      ],
    });
    const seeded = culture(`${unique}s`, { createdBy: null });

    expect(await inUnit(() => repository.add(market, state))).toBeNull();
    expect(await inUnit(() => repository.add(market, seeded))).toBeNull();

    expect(await inUnit(() => repository.findById(market, state.id))).toEqual(state);
    expect(await inUnit(() => repository.findById(market, seeded.id))).toEqual(seeded);
    expect(await inUnit(() => repository.codeTaken(market, state.code))).toBe(true);
    expect(await inUnit(() => repository.codeTaken(market, `${state.code}-x`))).toBe(false);
    expect(await inUnit(() => repository.count(market))).toBeGreaterThanOrEqual(2);
  });

  it('keeps a culture inside its Market and lets the other Market reuse a code and a name', async () => {
    const unique = letters(tag());
    const state = culture(unique);
    expect(await inUnit(() => repository.add(market, state))).toBeNull();

    expect(await inUnitOf(other)(() => repository.findById(other, state.id))).toBeNull();
    expect(await inUnit(() => repository.add(market, culture(unique)))).toBe('culture.code-taken');
    expect(
      await inUnit(() =>
        repository.add(
          market,
          culture(`${unique}b`, {
            names: [{ locale: 'en', name: `CULTURE ${unique}`, description: null }],
          }),
        ),
      ),
    ).toBe('culture.name-taken');
    expect(await inUnitOf(other)(() => repository.add(other, culture(unique)))).toBeNull();
  });

  it('replaces names under the version it was read at', async () => {
    const unique = letters(tag());
    const state = culture(unique);
    await inUnit(() => repository.add(market, state));

    const edited: CultureState = {
      ...state,
      status: 'active',
      displayOrder: 2,
      requiredCertificationType: 'halal',
      badgeColour: 'brand',
      names: [{ locale: 'en', name: `Renamed ${unique}`, description: 'New text' }],
      updatedAt: T1,
      version: 2,
    };
    expect(await inUnit(() => repository.save(market, edited, 1))).toBeNull();

    expect(await inUnit(() => repository.findById(market, state.id))).toEqual(edited);
    await expect(
      inUnit(() => repository.save(market, { ...edited, version: 3 }, 1)),
    ).rejects.toBeInstanceOf(StaleAggregateError);
  });

  it('allows one default per Market and moves it with clearDefaultExcept', async () => {
    const unique = letters(tag());
    const first = culture(`${unique}a`, { status: 'active' });
    const second = culture(`${unique}b`, { status: 'active' });
    await inUnit(() => repository.add(market, first));
    await inUnit(() => repository.add(market, second));
    await inUnit(() => repository.clearDefaultExcept(market, uuid7() as Id<'Culture'>, T0));
    expect(await inUnit(() => repository.defaultId(market))).toBeNull();

    await inUnit(() => repository.save(market, { ...first, isDefault: true, version: 2 }, 1));
    expect(await inUnit(() => repository.defaultId(market))).toBe(first.id);
    expect(
      await inUnit(() => repository.save(market, { ...second, isDefault: true, version: 2 }, 1)),
    ).toBe('conflict.stale');

    await inUnit(() => repository.clearDefaultExcept(market, second.id, T1));
    await inUnit(() => repository.save(market, { ...second, isDefault: true, version: 2 }, 1));
    expect(await inUnit(() => repository.defaultId(market))).toBe(second.id);
    expect((await inUnit(() => repository.findById(market, first.id)))?.isDefault).toBe(false);
    expect((await inUnit(() => repository.findById(market, first.id)))?.version).toBe(3);
  });

  it('turns two concurrent make-default edits into one winner and conflict.stale', async () => {
    const unique = letters(tag());
    const first = culture(`${unique}a`, { status: 'active' });
    const second = culture(`${unique}b`, { status: 'active' });
    await inUnit(() => repository.add(market, first));
    await inUnit(() => repository.add(market, second));
    await inUnit(() => repository.clearDefaultExcept(market, uuid7() as Id<'Culture'>, T0));

    // Both units clear "the others" before either saves, so each sees no default: the one-default
    // index is the only thing that can stop the second.
    let cleared = 0;
    let release!: () => void;
    const bothCleared = new Promise<void>((resolve) => (release = resolve));
    const makeDefault = (state: CultureState) =>
      inUnit(async () => {
        await repository.clearDefaultExcept(market, state.id, T1);
        cleared += 1;
        if (cleared === 2) release();
        await bothCleared;
        return repository.save(market, { ...state, isDefault: true, version: 2 }, 1);
      });
    const results = await Promise.all([makeDefault(first), makeDefault(second)]);

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict.stale')).toHaveLength(1);
    const defaultId = await inUnit(() => repository.defaultId(market));
    expect([first.id, second.id]).toContain(defaultId);
  });

  it('upserts the same mark row from two concurrent units without a key collision', async () => {
    const state = culture(letters(tag()));
    await inUnit(() => repository.add(market, state));
    const category = await insertCategory();
    const admin = uuid7() as Id<'Account'>;
    const set = (visible: boolean) =>
      inUnit(() =>
        repository.setCategoryRow(
          market,
          state.id,
          { categoryId: category, visible, certificationMark: null },
          admin,
          T1,
        ),
      );

    await Promise.all([set(true), set(false), set(true), set(false)]);

    expect(await inUnit(() => repository.categoryRows(market, state.id))).toHaveLength(1);
  });

  it('stores, upserts, lists and clears the mark rows of a culture', async () => {
    const state = culture(letters(tag()));
    await inUnit(() => repository.add(market, state));
    const [first, second] = [await insertCategory(), await insertCategory()];
    const admin = uuid7() as Id<'Account'>;

    await inUnit(() =>
      repository.setCategoryRow(
        market,
        state.id,
        { categoryId: first, visible: false, certificationMark: null },
        admin,
        T0,
      ),
    );
    await inUnit(() =>
      repository.setCategoryRow(
        market,
        state.id,
        { categoryId: second, visible: true, certificationMark: 'neutral' },
        admin,
        T0,
      ),
    );
    await inUnit(() =>
      repository.setCategoryRow(
        market,
        state.id,
        { categoryId: first, visible: true, certificationMark: 'required' },
        admin,
        T1,
      ),
    );

    const rows = await inUnit(() => repository.categoryRows(market, state.id));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { categoryId: first, visible: true, certificationMark: 'required' },
        { categoryId: second, visible: true, certificationMark: 'neutral' },
      ]),
    );
    expect(await inUnit(() => repository.clearCategoryRow(market, state.id, first))).toBe(true);
    expect(await inUnit(() => repository.clearCategoryRow(market, state.id, first))).toBe(false);
    expect(await inUnit(() => repository.categoryRows(market, state.id))).toHaveLength(1);
  });

  it('refuses a mark on a category of another Market or none', async () => {
    const state = culture(letters(tag()));
    await inUnit(() => repository.add(market, state));
    const foreign = await insertCategory(other);
    const row = (categoryId: Id<'Category'>) => ({
      categoryId,
      visible: true,
      certificationMark: null,
    });
    const admin = uuid7() as Id<'Account'>;

    await expect(
      inUnit(() => repository.setCategoryRow(market, state.id, row(foreign), admin, T0)),
    ).rejects.toThrow();
    await expect(
      inUnit(() =>
        repository.setCategoryRow(market, state.id, row(uuid7() as Id<'Category'>), admin, T0),
      ),
    ).rejects.toThrow();
  });

  it('lists by display order then code, with a status filter and a search in any locale', async () => {
    const unique = letters(tag());
    const states = [
      culture(`${unique}-c`, { displayOrder: 1, status: 'active' }),
      culture(`${unique}-a`, {
        displayOrder: 2,
        names: [
          { locale: 'ar', name: `ثقافة ${unique}`, description: null },
          { locale: 'en', name: `Shop ${unique}a`, description: 'd' },
        ],
      }),
      culture(`${unique}-b`, { displayOrder: 2, status: 'inactive' }),
    ];
    for (const state of states) await inUnit(() => repository.add(market, state));

    const all = await inUnit(() => reader.list(market, { status: null, search: unique }));
    expect(all.map((c) => c.code)).toEqual([states[0]!.code, states[1]!.code, states[2]!.code]);
    const inactive = await inUnit(() =>
      reader.list(market, { status: 'inactive', search: unique }),
    );
    expect(inactive.map((c) => c.id)).toEqual([states[2]!.id]);
    const arabic = await inUnit(() => reader.list(market, { status: null, search: 'ثقافة' }));
    expect(arabic.some((c) => c.id === states[1]!.id)).toBe(true);
    const foreign = await inUnitOf(other)(() =>
      reader.list(other, { status: null, search: unique }),
    );
    expect(foreign).toEqual([]);
  });

  it('enforces the CHECKs of the three tables', async () => {
    const insertCulture = (overrides: Record<string, unknown>) => {
      const row = {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        code: `chk-${letters(tag())}`,
        status: 'draft',
        display_order: 0,
        is_default: false,
        created_by: uuid7(),
        created_at: T0.toString(),
        updated_at: T0.toString(),
        version: 1,
        ...overrides,
      };
      const columns = Object.keys(row);
      return sqlState(
        sql,
        `INSERT INTO catalog.cultures (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    expect(await insertCulture({ code: 'Bad Code' })).toBe('23514');
    expect(await insertCulture({ status: 'deleted' })).toBe('23514');
    expect(await insertCulture({ status: 'DRAFT' })).toBe('23514');
    expect(await insertCulture({ display_order: 10000 })).toBe('23514');
    expect(await insertCulture({ required_certification_type: 'Halal!' })).toBe('23514');
    expect(await insertCulture({ badge_colour: '#fff' })).toBe('23514');
    expect(await insertCulture({ is_default: true, status: 'inactive' })).toBe('23514');
    expect(await insertCulture({ version: 0 })).toBe('23514');
    expect(await insertCulture({ tenant_id: 'BAD' })).toBe('23514');

    const state = culture(letters(tag()));
    await inUnit(() => repository.add(market, state));
    const insertName = (locale: string, name: string, description: string | null) =>
      sqlState(
        sql,
        `INSERT INTO catalog.culture_names (market_id, tenant_id, culture_id, locale, name, description)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [market.marketId, market.tenantId, state.id, locale, name, description],
      );
    expect(await insertName('EN!', 'Name', null)).toBe('23514');
    expect(await insertName('fr', ' Padded ', null)).toBe('23514');
    expect(await insertName('fr', '', null)).toBe('23514');
    expect(await insertName('fr', 'Name', ' padded ')).toBe('23514');
    expect(await insertName('fr', 'Name', 'x'.repeat(301))).toBe('23514');

    const category = await insertCategory();
    expect(
      await sqlState(
        sql,
        `INSERT INTO catalog.culture_categories
           (market_id, tenant_id, culture_id, category_id, visible, certification_mark, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, true, 'REQUIRED', $5, $6)`,
        [market.marketId, market.tenantId, state.id, category, uuid7(), T0.toString()],
      ),
    ).toBe('23514');
  });

  it('never lets the application change a code or a creator, or delete a culture', async () => {
    const state = culture(letters(tag()));
    await inUnit(() => repository.add(market, state));

    expect(
      await sqlState(sql, 'UPDATE catalog.culture_names SET name = $2 WHERE culture_id = $1', [
        state.id,
        'Renamed',
      ]),
    ).toBe('42501');
    expect(
      await sqlState(sql, 'UPDATE catalog.cultures SET code = $2 WHERE id = $1', [
        state.id,
        'renamed',
      ]),
    ).toBe('42501');
    expect(
      await sqlState(sql, 'UPDATE catalog.cultures SET created_by = $2 WHERE id = $1', [
        state.id,
        uuid7(),
      ]),
    ).toBe('42501');
    expect(await sqlState(sql, 'DELETE FROM catalog.cultures WHERE id = $1', [state.id])).toBe(
      '42501',
    );
  });
});
