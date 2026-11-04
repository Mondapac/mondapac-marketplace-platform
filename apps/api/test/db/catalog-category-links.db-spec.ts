import { randomUUID } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { CategoryAttributeLink } from '../../src/modules/catalog/domain/category-attribute-link';
import { PrismaCategoryAttributeLinkStore } from '../../src/modules/catalog/infrastructure/prisma-category-attribute-link.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The category attribute-link store on PostgreSQL (attributes plan, package A4; categories C8), for
// both Market fixtures, as the API role: a first link with its revision and author; the next
// revision behind the version, and a stale write that leaves nothing behind; a racing first link;
// the resolution read (`all`) returning only current revisions; the category status read; the
// Market boundary; and the hand-written constraints on the filters column and the insert-only
// revisions. Each test works on its own category, because other specs share the database.

const T0 = Temporal.Instant.from('2026-11-03T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-03T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('category attribute-link store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const author = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let store: PrismaCategoryAttributeLinkStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaCategoryAttributeLinkStore(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  async function insertCategory(
    target: MarketContext = market,
    status = 'active',
  ): Promise<Id<'Category'>> {
    const id = uuid7();
    await owner.query(
      `INSERT INTO catalog.platform_categories
         (id, market_id, tenant_id, slug, status, created_by_kind, version, created_at)
       VALUES ($1, $2, $3, $4, $5, 'seed', 1, $6)`,
      [
        id,
        target.marketId,
        target.tenantId,
        `l-${randomUUID().slice(0, 12)}`,
        status,
        T0.toString(),
      ],
    );
    return id as Id<'Category'>;
  }

  const linkOf = (
    categoryId: Id<'Category'>,
    filters: string[],
    familyId: string | null = null,
  ) => {
    const built = CategoryAttributeLink.create({
      marketId: market.marketId,
      categoryId,
      revisionId: uuid7() as Id<'CategoryAttributeLinkRevision'>,
      familyId: familyId as Id<'AttributeFamily'> | null,
      filters,
      now: T0,
    });
    if (!built.ok) throw new Error(built.error.code);
    return built.value;
  };
  const revise = (from: CategoryAttributeLink, filters: string[]) => {
    const next = from.revise({
      revisionId: uuid7() as Id<'CategoryAttributeLinkRevision'>,
      familyId: null,
      filters,
      now: T1,
    });
    if (!next.ok) throw new Error(next.error.code);
    return next.value;
  };

  it('adds a first link and reads it back with its author and Market', async () => {
    const categoryId = await insertCategory();
    const link = linkOf(categoryId, ['colour', 'size']);
    await write(market, () => store.add(market, link, author));
    const found = await read(market, () => store.find(market, categoryId));
    expect(found?.state).toEqual(link.state);
    const { rows } = await owner.query<{ author_account_id: string }>(
      'SELECT author_account_id FROM catalog.category_attribute_link_revisions WHERE id = $1',
      [link.state.revisionId],
    );
    expect(rows).toEqual([{ author_account_id: author }]);
    expect(await read(other, () => store.find(other, categoryId))).toBeNull();
    const unlinked = await insertCategory();
    expect(await read(market, () => store.find(market, unlinked))).toBeNull();
  });

  it('saves the next revision behind the version; a stale write leaves nothing behind', async () => {
    const categoryId = await insertCategory();
    const first = linkOf(categoryId, ['colour']);
    await write(market, () => store.add(market, first, author));
    const second = revise(first, ['size', 'colour']);
    await write(market, () => store.saveRevision(market, second, author));
    const found = await read(market, () => store.find(market, categoryId));
    expect(found?.state).toMatchObject({
      version: 2,
      revisionNo: 2,
      filters: ['size', 'colour'],
      revisedAt: T1,
      createdAt: T0,
    });

    const rival = revise(first, []);
    await expect(
      db.unitOfWork.run(market, async () => {
        await store.saveRevision(market, rival, author);
        return ok(true);
      }),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM catalog.category_attribute_link_revisions WHERE category_id = $1',
      [categoryId],
    );
    expect(rows[0]!.n).toBe('2');
  });

  it('refuses a second first link for the same category as a stale write', async () => {
    const categoryId = await insertCategory();
    await write(market, () => store.add(market, linkOf(categoryId, ['colour']), author));
    await expect(
      db.unitOfWork.run(market, async () => {
        await store.add(market, linkOf(categoryId, ['size']), author);
        return ok(true);
      }),
    ).rejects.toBeInstanceOf(StaleAggregateError);
  });

  it('answers the current link of every category, never an older revision or another Market', async () => {
    const categoryId = await insertCategory();
    const first = linkOf(categoryId, ['colour']);
    await write(market, () => store.add(market, first, author));
    await write(market, () => store.saveRevision(market, revise(first, ['size']), author));
    const all = await read(market, () => store.all(market, 100_000));
    const mine = all.filter((fact) => fact.categoryId === categoryId);
    expect(mine).toEqual([{ categoryId, familyId: null, filters: ['size'] }]);
    const elsewhere = await read(other, () => store.all(other, 100_000));
    expect(elsewhere.some((fact) => fact.categoryId === categoryId)).toBe(false);
  });

  it('reads the status of a category of its own Market only', async () => {
    const active = await insertCategory();
    const archived = await insertCategory(market, 'archived');
    expect(await read(market, () => store.categoryStatus(market, active))).toBe('active');
    expect(await read(market, () => store.categoryStatus(market, archived))).toBe('archived');
    expect(await read(other, () => store.categoryStatus(other, active))).toBeNull();
  });

  it('keeps the filters column an array of at most 20 and the revisions insert-only', async () => {
    const categoryId = await insertCategory();
    const link = linkOf(categoryId, ['colour']);
    await write(market, () => store.add(market, link, author));
    const insert = (filters: unknown, no: number) =>
      owner.query(
        `INSERT INTO catalog.category_attribute_link_revisions
           (id, market_id, tenant_id, category_id, revision_no, filters, author_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())`,
        [
          uuid7(),
          market.marketId,
          market.tenantId,
          categoryId,
          no,
          JSON.stringify(filters),
          author,
        ],
      );
    await expect(insert({ not: 'an array' }, 2)).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(
        Array.from({ length: 21 }, (_, i) => `f${i}`),
        2,
      ),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      owner.query('UPDATE catalog.category_attribute_link_revisions SET filters = $1::jsonb', [
        '[]',
      ]),
    ).rejects.toThrow();
    await expect(
      owner.query('DELETE FROM catalog.category_attribute_link_revisions WHERE id = $1', [
        link.state.revisionId,
      ]),
    ).rejects.toThrow();
  });
});
