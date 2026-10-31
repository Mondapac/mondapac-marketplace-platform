import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Brand, brandNameKey } from '../../src/modules/catalog/domain/brand';
import { PrismaBrandAssigner } from '../../src/modules/catalog/infrastructure/prisma-brand.assigner';
import { PrismaBrandReader } from '../../src/modules/catalog/infrastructure/prisma-brand.reader';
import { PrismaBrandRepository } from '../../src/modules/catalog/infrastructure/prisma-brand.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { sqlState } from './sql-state';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The catalog brand package on PostgreSQL, for both Market fixtures: the constraints of the three
// tables, the triggers, the repository, the reader and the assigner. Brands are shared by every
// Market, so each case builds its own brands under a name nobody else uses (a random prefix per
// case) and asserts on those rows only, never on the table as a whole.

const T0 = Temporal.Instant.from('2026-10-28T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-28T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const tag = (): string => randomUUID().replaceAll('-', '').slice(0, 10);
const letters = (value: string): string =>
  value.replace(/[0-9]/g, (digit) => 'abcdefghij'[Number(digit)]!);

describe.each(TEST_MARKETS)('catalog brands in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let repository: PrismaBrandRepository;
  let reader: PrismaBrandReader;
  let assigner: PrismaBrandAssigner;
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    repository = new PrismaBrandRepository(persistence.service, {
      next: <K extends string>() => uuid7() as Id<K>,
    });
    reader = new PrismaBrandReader(persistence.service);
    assigner = new PrismaBrandAssigner(persistence.service);
    app = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await app.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
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

  /** A brand of this case, under a name and slug no other case can produce. */
  function newBrand(
    unique: string,
    overrides: { name?: string; seller?: Id<'Seller'>; slug?: string } = {},
  ): Brand {
    const created = Brand.create({
      id: uuid7() as Id<'Brand'>,
      content: {
        name: overrides.name ?? `Brand ${unique}`,
        summary: null,
        originCountry: 'AU',
        logoImageId: null,
        logoAlt: null,
        headerImageId: null,
      },
      slug: overrides.slug ?? `brand-${unique}`,
      origin:
        overrides.seller === undefined
          ? { kind: 'admin', accountId: uuid7() as Id<'Account'> }
          : { kind: 'seller', sellerId: overrides.seller },
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  }

  const addBrand = async (brand: Brand): Promise<Brand> => {
    expect(await inUnit(() => repository.add(market, brand))).toBeNull();
    return brand;
  };

  async function insertProduct(
    target: typeof market,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = uuid7();
    const row = {
      id,
      market_id: target.marketId,
      tenant_id: target.tenantId,
      scope: 'PLATFORM',
      owner_seller_id: null,
      created_by_seller_id: null,
      type_code: 'configurable',
      variant_model: 'options',
      family_code: 'default',
      product_code: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: T0.toString(),
      version: 1,
      created_at: T0.toString(),
      ...overrides,
    };
    const columns = Object.keys(row);
    await app.query(
      `INSERT INTO catalog.products (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
    return id;
  }

  const brandIdOf = async (productId: string): Promise<string | null> =>
    (
      await app.query<{ brand_id: string | null }>(
        'SELECT brand_id FROM catalog.products WHERE id = $1',
        [productId],
      )
    ).rows[0]!.brand_id;

  describe('constraints and triggers', () => {
    it('keeps a slug unique across all brands', async () => {
      const unique = letters(tag());
      const first = await addBrand(newBrand(unique));
      const second = newBrand(`${unique}x`, { slug: first.state.slug });
      expect(await inUnit(() => repository.add(market, second))).toBe('brand.slug-taken');
      expect(
        await sqlState(
          app,
          `INSERT INTO catalog.brands (id, slug, name, name_key, status, created_at, updated_at, version)
           VALUES ($1, $2, $3, $4, 'active', now(), now(), 1)`,
          [uuid7(), first.state.slug, `Other ${unique}`, `other${unique}`],
        ),
      ).toBe('23505');
    });

    it('keeps an alias unique whatever its case, across brands', async () => {
      const unique = letters(tag());
      const one = await addBrand(newBrand(`${unique}a`));
      const two = await addBrand(newBrand(`${unique}b`));
      const alias = `Alias ${unique}`;
      expect(await inUnit(() => repository.addAliases(market, one.state.id, [alias], T0))).toEqual([
        alias,
      ]);
      // The same spelling in other case, on another brand and on the same one: refused by the index.
      for (const target of [two, one]) {
        expect(
          await sqlState(
            app,
            `INSERT INTO catalog.brand_aliases (id, brand_id, alias, created_at) VALUES ($1, $2, $3, now())`,
            [uuid7(), target.state.id, alias.toUpperCase()],
          ),
        ).toBe('23505');
      }
      // The repository skips the held spelling without an error and reports only new ones.
      expect(
        await inUnit(() =>
          repository.addAliases(market, two.state.id, [alias.toLowerCase(), `Fresh ${unique}`], T0),
        ),
      ).toEqual([`Fresh ${unique}`]);
      expect(await inUnit(() => repository.aliasesOf(market, one.state.id))).toEqual([alias]);
    });

    it('refuses a product naming no brand, and the deletion of a brand', async () => {
      const brand = await addBrand(newBrand(letters(tag())));
      const productId = await insertProduct(market);
      expect(
        await sqlState(app, 'UPDATE catalog.products SET brand_id = $1 WHERE id = $2', [
          uuid7(),
          productId,
        ]),
      ).toBe('23503');
      expect(
        await sqlState(app, 'UPDATE catalog.products SET brand_id = $1 WHERE id = $2', [
          brand.state.id,
          productId,
        ]),
      ).toBeNull();
      expect(
        await sqlState(app, 'DELETE FROM catalog.brands WHERE id = $1', [brand.state.id]),
      ).not.toBeNull();
      expect(
        await sqlState(owner, 'DELETE FROM catalog.brands WHERE id = $1', [brand.state.id]),
      ).not.toBeNull();
    });

    it('refuses a brand row that breaks a check', async () => {
      const unique = letters(tag());
      const insert = (overrides: Record<string, unknown>) => {
        const row = {
          id: uuid7(),
          slug: `chk-${unique}-${tag()}`,
          name: `Chk ${unique}`,
          name_key: `chk${unique}`,
          status: 'active',
          created_at: T0.toString(),
          updated_at: T0.toString(),
          version: 1,
          ...overrides,
        };
        const columns = Object.keys(row);
        return sqlState(
          app,
          `INSERT INTO catalog.brands (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
      };
      expect(await insert({ slug: 'Not A Slug' })).toBe('23514');
      expect(await insert({ status: 'live' })).toBe('23514');
      expect(await insert({ name: ' padded ' })).toBe('23514');
      expect(await insert({ origin_country: 'au' })).toBe('23514');
      expect(await insert({ status: 'draft', approved_by: uuid7() })).toBe('23514');
      expect(await insert({ logo_image_id: uuid7() })).toBe('23514');
      expect(await insert({})).toBeNull();
    });

    it('lets the application change a brand but not its identity columns', async () => {
      const brand = await addBrand(newBrand(letters(tag())));
      expect(
        await sqlState(app, 'UPDATE catalog.brands SET id = $1 WHERE id = $2', [
          uuid7(),
          brand.state.id,
        ]),
      ).toBe('42501');
      expect(
        await sqlState(app, 'UPDATE catalog.brands SET created_at = now() WHERE id = $1', [
          brand.state.id,
        ]),
      ).toBe('42501');
    });
  });

  describe('the repository', () => {
    it('stores a brand and reads it back by id and by slug', async () => {
      const unique = letters(tag());
      const brand = await addBrand(newBrand(unique));
      const byId = await inUnit(() => repository.findById(market, brand.state.id));
      expect(byId!.state).toEqual(brand.state);
      const bySlug = await inUnit(() => repository.findBySlug(market, brand.state.slug));
      expect(bySlug!.state.id).toBe(brand.state.id);
      expect(await inUnit(() => repository.slugTaken(market, brand.state.slug))).toBe(true);
      expect(await inUnit(() => repository.slugTaken(market, `free-${unique}`))).toBe(false);
      // Brands are shared: the other Market reads the same row.
      const seenFromOther = await inUnitOf(other)(() => repository.findById(other, brand.state.id));
      expect(seenFromOther!.state.id).toBe(brand.state.id);
    });

    it('saves a change with the version check, and refuses a stale copy', async () => {
      const brand = await addBrand(newBrand(letters(tag())));
      const first = (await inUnit(() => repository.findById(market, brand.state.id)))!;
      const second = (await inUnit(() => repository.findById(market, brand.state.id)))!;
      const edited = first.edit({
        content: {
          name: `${first.state.name} Renamed`,
          summary: 'A summary',
          originCountry: 'NZ',
          logoImageId: null,
          logoAlt: null,
          headerImageId: null,
        },
        now: T1,
      });
      if (!edited.ok) throw new Error(edited.error.code);
      expect(await inUnit(() => repository.save(market, edited.value))).toBeNull();
      const stored = (await inUnit(() => repository.findById(market, brand.state.id)))!;
      expect(stored.state).toMatchObject({
        name: `${first.state.name} Renamed`,
        nameKey: brandNameKey(`${first.state.name} Renamed`),
        version: 2,
      });
      const stale = second.archive({ now: T1 });
      if (!stale.ok) throw new Error(stale.error.code);
      await expect(inUnit(() => repository.save(market, stale.value))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
    });

    it('counts the open proposals of a seller, and finds near-duplicates by key and alias', async () => {
      const unique = letters(tag());
      const seller = uuid7() as Id<'Seller'>;
      expect(await inUnit(() => repository.openProposalCount(market, seller))).toBe(0);
      const proposal = await addBrand(newBrand(`${unique}p`, { seller }));
      expect(proposal.state.status).toBe('draft');
      expect(await inUnit(() => repository.openProposalCount(market, seller))).toBe(1);

      const active = await addBrand(newBrand(`${unique}q`, { name: `Fuji & Co ${unique}` }));
      await inUnit(() =>
        repository.addAliases(market, active.state.id, [`Known As ${unique}`], T0),
      );
      const similar = await inUnit(() =>
        repository.similarTo(market, {
          name: `FUJI AND CO ${unique}`,
          nameKey: brandNameKey(`FUJI AND CO ${unique}`),
          limit: 5,
        }),
      );
      expect(similar.map((state) => state.id)).toEqual([active.state.id]);
      const byAlias = await inUnit(() =>
        repository.similarTo(market, {
          name: `known as ${unique}`,
          nameKey: brandNameKey(`known as ${unique}`),
          limit: 5,
        }),
      );
      expect(byAlias.map((state) => state.id)).toEqual([active.state.id]);
      const owners = await inUnit(() =>
        repository.spellingOwners(market, `fuji & co ${unique}`.toUpperCase(), 5),
      );
      expect(owners.map((state) => state.id)).toEqual([active.state.id]);
    });

    it('moves aliases and the products of this Market on a merge, and settles the queue rows', async () => {
      const unique = letters(tag());
      const source = await addBrand(newBrand(`${unique}s`));
      const target = await addBrand(newBrand(`${unique}t`));
      await inUnit(() => repository.addAliases(market, source.state.id, [`Src ${unique}`], T0));
      const mine = await insertProduct(market);
      const theirs = await insertProduct(other);
      for (const productId of [mine, theirs]) {
        await app.query('UPDATE catalog.products SET brand_id = $1 WHERE id = $2', [
          source.state.id,
          productId,
        ]);
      }
      const groupKey = `grp${unique}`;
      for (const brand of [source, target]) {
        await app.query(
          `INSERT INTO catalog.brand_merge_candidates (id, group_key, brand_id, status, detected_at)
           VALUES ($1, $2, $3, 'open', now())`,
          [uuid7(), groupKey, brand.state.id],
        );
      }
      const queued = await inUnit(() => reader.mergeQueue(market, 200));
      expect(
        queued
          .find((group) => group.groupKey === groupKey)!
          .brands.map((entry) => [entry.brand.id, entry.productCount]),
      ).toEqual([
        [source.state.id, 1],
        [target.state.id, 0],
      ]);

      await inUnit(async () => {
        await repository.moveAliases(market, source.state.id, target.state.id);
        expect(await repository.moveProducts(market, source.state.id, target.state.id)).toBe(1);
        await repository.resolveMerged(market, {
          sources: [source.state.id],
          target: target.state.id,
          accountId: uuid7() as Id<'Account'>,
          now: T1,
        });
      });
      expect(await brandIdOf(mine)).toBe(target.state.id);
      // The other Market's product is not this unit's to move.
      expect(await brandIdOf(theirs)).toBe(source.state.id);
      expect(await inUnit(() => repository.aliasesOf(market, target.state.id))).toEqual([
        `Src ${unique}`,
      ]);
      const rows = await app.query<{ brand_id: string; status: string; resolution: string | null }>(
        'SELECT brand_id, status, resolution FROM catalog.brand_merge_candidates WHERE group_key = $1',
        [groupKey],
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows)
        expect(row).toMatchObject({ status: 'resolved', resolution: 'merged' });
      expect(await inUnit(() => reader.mergeQueue(market, 200))).not.toContainEqual(
        expect.objectContaining({ groupKey }),
      );
    });

    it('dismisses a queue group as kept separate, once', async () => {
      const unique = letters(tag());
      const one = await addBrand(newBrand(`${unique}1`));
      const two = await addBrand(newBrand(`${unique}2`));
      const groupKey = `dis${unique}`;
      for (const brand of [one, two]) {
        await app.query(
          `INSERT INTO catalog.brand_merge_candidates (id, group_key, brand_id, status, detected_at)
           VALUES ($1, $2, $3, 'open', now())`,
          [uuid7(), groupKey, brand.state.id],
        );
      }
      const dismiss = () =>
        inUnit(() =>
          repository.dismissGroup(market, {
            groupKey,
            accountId: uuid7() as Id<'Account'>,
            now: T1,
          }),
        );
      expect(await dismiss()).toBe(2);
      expect(await dismiss()).toBe(0);
      const rows = await app.query<{ resolution: string }>(
        'SELECT resolution FROM catalog.brand_merge_candidates WHERE group_key = $1',
        [groupKey],
      );
      expect(rows.rows.map((row) => row.resolution)).toEqual(['kept-separate', 'kept-separate']);
      // A resolved row cannot be reopened without its outcome (check constraint).
      expect(
        await sqlState(
          app,
          `UPDATE catalog.brand_merge_candidates SET status = 'open' WHERE group_key = $1`,
          [groupKey],
        ),
      ).toBe('23514');
    });
  });

  describe('the reader and the assigner', () => {
    it('answers the public read for an active brand only, with the count of this Market', async () => {
      const unique = letters(tag());
      const brand = await addBrand(newBrand(unique));
      const draft = await addBrand(newBrand(`${unique}d`, { seller: uuid7() as Id<'Seller'> }));
      const published = await insertProduct(market);
      await app.query('UPDATE catalog.products SET brand_id = $1 WHERE id = $2', [
        brand.state.id,
        published,
      ]);
      const record = await inUnit(() => reader.publicBySlug(market, brand.state.slug));
      expect(record!.brand.id).toBe(brand.state.id);
      // No Offer is on sale: a product without one is not live.
      expect(record!.liveProductCount).toBe(0);
      expect(await inUnit(() => reader.publicBySlug(market, draft.state.slug))).toBeNull();
      expect(await inUnit(() => reader.publicBySlug(market, `none-${unique}`))).toBeNull();

      const detail = await inUnit(() => reader.detail(market, brand.state.id));
      expect(detail!.productCount).toBe(1);
      const detailOther = await inUnitOf(other)(() => reader.detail(other, brand.state.id));
      expect(detailOther!.productCount).toBe(0);

      const active = await inUnit(() => reader.publicActive(market, 5000));
      expect(active.map((state) => state.id)).toContain(brand.state.id);
      expect(active.map((state) => state.id)).not.toContain(draft.state.id);
    });

    it('lists and searches brands by status and text, with a keyset cursor', async () => {
      const unique = letters(tag());
      const brands: Brand[] = [];
      for (const suffix of ['a', 'b', 'c']) {
        brands.push(
          await addBrand(newBrand(`${unique}${suffix}`, { name: `Zz${unique} ${suffix}` })),
        );
      }
      const first = await inUnit(() =>
        reader.list(market, { status: 'active', search: unique, afterId: null, limit: 2 }),
      );
      expect(first.items.map((state) => state.name)).toEqual([`Zz${unique} a`, `Zz${unique} b`]);
      expect(first.nextAfterId).toBe(first.items[1]!.id);
      const second = await inUnit(() =>
        reader.list(market, {
          status: 'active',
          search: unique.toUpperCase(),
          afterId: first.nextAfterId,
          limit: 2,
        }),
      );
      expect(second.items.map((state) => state.name)).toEqual([`Zz${unique} c`]);
      expect(second.nextAfterId).toBeNull();
      const drafts = await inUnit(() =>
        reader.list(market, { status: 'draft', search: unique, afterId: null, limit: 5 }),
      );
      expect(drafts.items).toEqual([]);
    });

    it('knows whether a seller has an ownBrand product in this Market only', async () => {
      const seller = uuid7() as Id<'Seller'>;
      expect(await inUnit(() => reader.sellerHasOwnBrandProduct(market, seller))).toBe(false);
      await insertProduct(other, {
        scope: 'SELLER',
        owner_seller_id: seller,
        created_by_seller_id: seller,
        own_brand: true,
      });
      expect(await inUnit(() => reader.sellerHasOwnBrandProduct(market, seller))).toBe(false);
      await insertProduct(market, {
        scope: 'SELLER',
        owner_seller_id: seller,
        created_by_seller_id: seller,
        own_brand: true,
      });
      expect(await inUnit(() => reader.sellerHasOwnBrandProduct(market, seller))).toBe(true);
    });

    it('assigns a published brand value to the product: exact, slug, case, alias, then clears', async () => {
      const unique = letters(tag());
      const brand = await addBrand(newBrand(unique, { name: `Mixed Case ${unique}` }));
      await inUnit(() => repository.addAliases(market, brand.state.id, [`Old Name ${unique}`], T0));
      const draft = await addBrand(newBrand(`${unique}d`, { seller: uuid7() as Id<'Seller'> }));
      const productId = await insertProduct(market);
      const assign = (value: string | null) =>
        inUnit(() => assigner.assignFromPublished(market, productId as Id<'Product'>, value));

      await assign(`  Mixed Case ${unique}  `);
      expect(await brandIdOf(productId)).toBe(brand.state.id);
      await assign(null);
      expect(await brandIdOf(productId)).toBeNull();
      await assign(brand.state.slug);
      expect(await brandIdOf(productId)).toBe(brand.state.id);
      await assign('something else');
      expect(await brandIdOf(productId)).toBeNull();
      await assign(`MIXED CASE ${unique}`);
      expect(await brandIdOf(productId)).toBe(brand.state.id);
      await assign(`old name ${unique}`);
      await assign(`old name ${unique}`);
      expect(await brandIdOf(productId)).toBe(brand.state.id);
      // A draft (proposed) brand is not assignable until approved.
      await assign(draft.state.name);
      expect(await brandIdOf(productId)).toBeNull();
    });

    it('does not touch a product of the other Market', async () => {
      const unique = letters(tag());
      const brand = await addBrand(newBrand(unique));
      const theirs = await insertProduct(other);
      await inUnit(() =>
        assigner.assignFromPublished(market, theirs as Id<'Product'>, brand.state.name),
      );
      expect(await brandIdOf(theirs)).toBeNull();
    });
  });
});
