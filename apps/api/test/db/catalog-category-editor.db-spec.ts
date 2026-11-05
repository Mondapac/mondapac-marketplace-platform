import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { NewCategory } from '../../src/modules/catalog/application/ports/category-edit.store';
import type { EditableCategory } from '../../src/modules/catalog/domain/category-edit';
import { PrismaAdminCategoryReader } from '../../src/modules/catalog/infrastructure/prisma-admin-category.reader';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaCategoryEditStore } from '../../src/modules/catalog/infrastructure/prisma-category-edit.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The category tree editor's store on PostgreSQL, for both Market fixtures (categories package
// C3a): a new category is hidden, last among its siblings, with its first revision and the full
// texts; a change writes the next revision (texts before names) and moves the pointer under the
// version guard; the app role may set the slug and the cascade marker but nothing it should not;
// the slug history keeps a retired slug from another category for 12 months; positions swap
// without a gap or a clash; the discard facts; and the Market boundary.

// The slug history keeps a retired slug for 12 months of the database's own clock, so the
// instants of this spec follow today: a fixed date would stop proving it a year from now.
const T0 = Temporal.Now.instant();
const NOW = T0.add({ hours: 24 });
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ADMIN = uuid7() as Id<'Account'>;

describe.each(TEST_MARKETS)('catalog category editor store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let store: PrismaCategoryEditStore;
  let reader: PrismaAdminCategoryReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaCategoryEditStore(db.service);
    reader = new PrismaAdminCategoryReader(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  const texts = (name: string, extra: Partial<EditableCategory['texts'][number]> = {}) => [
    { locale: 'en-AU', name, shortDescription: null, keywords: [], ...extra },
  ];
  const slugOf = (): string => `ed-${uuid7().slice(-12)}`;

  async function add(
    target: typeof market,
    parentId: string | null,
    name: string,
    patch: Partial<NewCategory> = {},
  ): Promise<Id<'Category'>> {
    const id = uuid7() as Id<'Category'>;
    await write(target, () =>
      store.insert(target, {
        id,
        revisionId: uuid7() as Id<'CategoryRevision'>,
        parentId: parentId as Id<'Category'> | null,
        slug: slugOf(),
        texts: texts(name),
        seo: { title: null, description: null, noindex: false },
        showInMenu: true,
        authorAccountId: ADMIN,
        now: T0,
        ...patch,
      }),
    );
    return id;
  }
  const load = async (target: typeof market, id: string): Promise<EditableCategory> => {
    const all = await read(target, () => store.loadAll(target, 10_000));
    const found = all.find((node) => node.id === id);
    if (found === undefined) throw new Error('category not found');
    return found;
  };
  const change = async (
    target: typeof market,
    category: EditableCategory,
    kind: Parameters<typeof store.apply>[1]['kind'],
    patch: Parameters<typeof store.apply>[1]['patch'] = {},
    newTexts: EditableCategory['texts'] = category.texts,
  ) =>
    write(target, () =>
      store.apply(target, {
        category,
        revisionId: uuid7() as Id<'CategoryRevision'>,
        kind,
        texts: newTexts,
        patch,
        authorAccountId: ADMIN,
        now: T0,
      }),
    );

  it('inserts a hidden admin category last among its siblings with revision 1 and the full texts', async () => {
    const parent = await add(market, null, 'Parent');
    const first = await add(market, parent, 'First');
    const second = await add(market, parent, 'Second', {
      texts: texts('Second', { shortDescription: 'Short', keywords: ['one', 'two'] }),
      seo: { title: 'Second | Mondapac', description: 'About', noindex: true },
      showInMenu: false,
    });
    const a = await load(market, first);
    const b = await load(market, second);
    expect(a).toMatchObject({
      status: 'hidden',
      createdByKind: 'admin',
      position: 0,
      version: 1,
      revisionNo: 1,
    });
    expect(b).toMatchObject({
      status: 'hidden',
      position: 1,
      showInMenu: false,
      seo: { title: 'Second | Mondapac', description: 'About', noindex: true },
    });
    expect(b.texts).toEqual(
      texts('Second', { shortDescription: 'Short', keywords: ['one', 'two'] }),
    );
    const names = await owner.query(
      `SELECT n.locale, n.name FROM catalog.platform_category_revision_names n
         JOIN catalog.platform_categories c ON c.published_revision_id = n.revision_id
        WHERE c.id = $1`,
      [second],
    );
    expect(names.rows).toEqual([{ locale: 'en-AU', name: 'Second' }]);
  });

  it('writes the next revision and moves the pointer; a stale version is refused', async () => {
    const id = await add(market, null, 'Pantry');
    const v1 = await load(market, id);
    const version = await change(
      market,
      v1,
      'details-changed',
      { showInMenu: false, seo: { title: 'T', description: null, noindex: false } },
      texts('Pantry goods', { keywords: ['dry'] }),
    );
    expect(version).toBe(2);
    const v2 = await load(market, id);
    expect(v2).toMatchObject({ version: 2, revisionNo: 2, showInMenu: false });
    expect(v2.texts).toEqual(texts('Pantry goods', { keywords: ['dry'] }));
    expect(v2.seo.title).toBe('T');
    await expect(change(market, v1, 'details-changed')).rejects.toBeInstanceOf(StaleAggregateError);
    const revisions = await owner.query(
      'SELECT revision_no, change_kind, author_kind, author_account_id FROM catalog.platform_category_revisions WHERE category_id = $1 ORDER BY revision_no',
      [id],
    );
    expect(revisions.rows).toEqual([
      { revision_no: 1, change_kind: 'created', author_kind: 'admin', author_account_id: ADMIN },
      {
        revision_no: 2,
        change_kind: 'details-changed',
        author_kind: 'admin',
        author_account_id: ADMIN,
      },
    ]);
  });

  it('hides with a cascade marker and shows again; the marker needs the hidden status', async () => {
    const parent = await add(market, null, 'Top');
    const child = await add(market, parent, 'Kid');
    await change(market, await load(market, parent), 'shown', { status: 'active' });
    await change(market, await load(market, child), 'shown', { status: 'active' });
    await change(market, await load(market, child), 'hidden', {
      status: 'hidden',
      hiddenById: parent,
    });
    expect(await load(market, child)).toMatchObject({ status: 'hidden', hiddenById: parent });
    await change(market, await load(market, child), 'shown', {
      status: 'active',
      hiddenById: null,
    });
    expect(await load(market, child)).toMatchObject({ status: 'active', hiddenById: null });
    await expect(
      change(market, await load(market, child), 'shown', { hiddenById: parent }),
    ).rejects.toThrow();
    const detail = await read(market, () => reader.detail(market, child));
    expect(detail?.hiddenById).toBeNull();
  });

  it('refuses a cascade marker that breaks the CHECK or crosses a Market, by code and constraint', async () => {
    const parent = await add(market, null, 'Marker parent');
    const child = await add(market, parent, 'Marker child');
    const foreign = await add(other, null, 'Marker foreign');
    const set = (status: string, hiddenBy: string, id: string) =>
      owner.query(
        `UPDATE catalog.platform_categories SET status = $1, hidden_by_id = $2
          WHERE market_id = $3 AND id = $4`,
        [status, hiddenBy, market.marketId, id],
      );
    // Active with a marker: the CHECK says only a hidden category carries one.
    await expect(set('active', parent, child)).rejects.toMatchObject({
      code: '23514',
      constraint: 'platform_categories_hidden_by_check',
    });
    // A category cannot have hidden itself.
    await expect(set('hidden', child, child)).rejects.toMatchObject({
      code: '23514',
      constraint: 'platform_categories_hidden_by_check',
    });
    // A category of another Market is not a valid hider: the composite FK includes market_id.
    await expect(set('hidden', foreign, child)).rejects.toMatchObject({
      code: '23503',
      constraint: 'platform_categories_market_id_hidden_by_id_fkey',
    });
    // The valid shape is accepted.
    await expect(set('hidden', parent, child)).resolves.toBeTruthy();
  });

  it('changes the slug, keeps the old one in the history and refuses another category taking it', async () => {
    const id = await add(market, null, 'Renamed');
    const before = await load(market, id);
    const fresh = slugOf();
    await write(market, async () => {
      await store.retireSlug(market, id, before.slug, T0);
      await store.apply(market, {
        category: before,
        revisionId: uuid7() as Id<'CategoryRevision'>,
        kind: 'slug-changed',
        texts: before.texts,
        patch: { slug: fresh },
        authorAccountId: ADMIN,
        now: T0,
      });
    });
    expect((await load(market, id)).slug).toBe(fresh);
    expect(await read(market, () => store.slugUnavailable(market, before.slug, null, NOW))).toBe(
      true,
    );
    expect(await read(market, () => store.slugUnavailable(market, before.slug, id, NOW))).toBe(
      false,
    );
    expect(await read(market, () => store.slugUnavailable(market, fresh, null, NOW))).toBe(true);
    expect(await read(market, () => store.slugUnavailable(market, slugOf(), null, NOW))).toBe(
      false,
    );
    // The database says the same when a second category tries to take the retired slug.
    const intruder = await add(market, null, 'Intruder');
    await expect(
      change(market, await load(market, intruder), 'slug-changed', { slug: before.slug }),
    ).rejects.toThrow(/retired less than 12 months ago/);
  });

  it('swaps the positions of two siblings without a clash', async () => {
    const parent = await add(market, null, 'Swap parent');
    const a = await add(market, parent, 'A');
    const b = await add(market, parent, 'B');
    const c = await add(market, parent, 'C');
    const [na, nb] = [await load(market, a), await load(market, b)];
    await write(market, () => store.swapPositions(market, na, nb));
    expect(
      await Promise.all([a, b, c].map(async (id) => (await load(market, id)).position)),
    ).toEqual([1, 0, 2]);
    // A stale copy (the positions changed since it was read) is refused.
    await expect(write(market, () => store.swapPositions(market, na, nb))).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
  });

  it('reports whether a category was ever shown and how many product revisions name it', async () => {
    const id = await add(market, null, 'Facts');
    expect(await read(market, () => store.discardFacts(market, id))).toEqual({
      everShown: false,
      productRevisions: 0,
    });
    await change(market, await load(market, id), 'shown', { status: 'active' });
    expect((await read(market, () => store.discardFacts(market, id))).everShown).toBe(true);
  });

  it('archives a category on discard and leaves its row', async () => {
    const id = await add(market, null, 'Gone');
    await change(market, await load(market, id), 'discarded', {
      status: 'archived',
      hiddenById: null,
    });
    expect(await load(market, id)).toMatchObject({ status: 'archived' });
  });

  it('keeps a hidden category in a product path (claim path) and the lock takes slugs in order', async () => {
    // A hidden category keeps its products on sale (plan decision 6): the claim path through it is
    // the same as before it was hidden, so a category-policy lookup still sees its selectors.
    const top = await add(market, null, 'Path top');
    const mid = await add(market, top, 'Path mid');
    const leaf = await add(market, mid, 'Path leaf');
    for (const id of [top, mid, leaf]) {
      await change(market, await load(market, id), 'hidden', { status: 'hidden' });
    }
    const paths = new PrismaCategoryPathsReader(db.service);
    expect(await read(market, () => paths.livePaths(market, [leaf]))).toEqual([[top, mid, leaf]]);
    // Two units naming the same pair of slugs in opposite order do not deadlock: both lock sorted.
    const pair = [slugOf(), slugOf()];
    await Promise.all([
      write(market, () => store.lockSlugs(market, [pair[0]!, pair[1]!])),
      write(market, () => store.lockSlugs(market, [pair[1]!, pair[0]!])),
    ]);
  });

  it('refuses a nested keywords array, by the ndims check on its own', async () => {
    const id = await add(market, null, 'Nested keywords');
    const found = await owner.query<{ revision_id: string; tenant_id: string }>(
      `SELECT r.id AS revision_id, r.tenant_id FROM catalog.platform_category_revisions r
        WHERE r.market_id = $1 AND r.category_id = $2 LIMIT 1`,
      [market.marketId, id],
    );
    const { revision_id: revisionId, tenant_id: tenantId } = found.rows[0]!;
    const insert = `INSERT INTO catalog.platform_category_revision_texts
           (market_id, tenant_id, revision_id, locale, name, keywords)
         VALUES ($1, $2, $3, 'de', 'Nested', '{{a},{b}}')`;
    // With both checks in place the C2 check fails first (it cannot search a nested array).
    await expect(owner.query(insert, [market.marketId, tenantId, revisionId])).rejects.toThrow();
    // Inside a transaction that is rolled back, drop the C2 check: the ndims check alone refuses.
    await owner.query('BEGIN');
    try {
      await owner.query(
        'ALTER TABLE catalog.platform_category_revision_texts DROP CONSTRAINT platform_category_revision_texts_keywords_check',
      );
      await expect(owner.query(insert, [market.marketId, tenantId, revisionId])).rejects.toThrow(
        /keywords_ndims_check/,
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('never shows another Market a category and keeps slugs per Market', async () => {
    const id = await add(market, null, 'Mine');
    const mine = await load(market, id);
    expect(
      await read(other, () => store.loadAll(other, 10_000)).then((all) =>
        all.some((n) => n.id === id),
      ),
    ).toBe(false);
    expect(await read(other, () => store.slugUnavailable(other, mine.slug, null, NOW))).toBe(false);
  });

  it('keeps the grants tight: no delete, no change of the creator or of a revision', async () => {
    const id = await add(market, null, 'Grants');
    const probe = new Client({ connectionString: testDatabaseUrl() });
    await probe.connect();
    try {
      await expect(
        probe.query('UPDATE catalog.platform_categories SET created_by_kind = $1 WHERE id = $2', [
          'seed',
          id,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        probe.query('DELETE FROM catalog.platform_categories WHERE id = $1', [id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        probe.query('UPDATE catalog.platform_category_revision_texts SET name = $1', ['x']),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await probe.end();
    }
  });
});
