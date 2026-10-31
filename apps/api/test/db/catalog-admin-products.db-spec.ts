import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AdminProductsList } from '../../src/modules/catalog/application/use-cases/admin-products-list.use-case';
import type { AdminProductsListInput } from '../../src/modules/catalog/application/use-cases/admin-products-list.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import type { ProductStatus } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaAdminProductsReader } from '../../src/modules/catalog/infrastructure/prisma-admin-products.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// `admin-products.list` on PostgreSQL, for both Market fixtures (catalog design 8.2, 9.2): the
// tabs and their counts, the search over name and code (a LIKE wildcard typed is matched as
// typed), each filter, the three sorts and the page, the row fields (category name, primary
// photo, offer count, the pending revision's name for a never-published product) and the Market
// boundary (canary). Each test works on its own seller or marker, because other specs share
// the database.

const T0 = Temporal.Instant.from('2026-10-30T00:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog admin products list in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = policy.locales(market).default;
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;
  let list: AdminProductsList;
  let storeNames: Map<Id<'Seller'>, string>;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    offers = new PrismaOfferRepository(db.service, {
      next: <K extends string>() => uuid7() as Id<K>,
    });
    storeNames = new Map();
    list = new AdminProductsList(
      createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) }),
      {
        unitOfWork: db.unitOfWork,
        adminProductsReader: new PrismaAdminProductsReader(db.service),
        policy,
        sellerNames: { storeNames: () => Promise.resolve(storeNames) },
      },
    );
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    await owner.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  const base = (target: typeof market) => ({
    market_id: target.marketId,
    tenant_id: target.tenantId,
  });
  const adminContext = (target: typeof market = market) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId: uuid7() as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
    );
  const ask = async (input: AdminProductsListInput, target: typeof market = market) => {
    const result = await list.execute(adminContext(target), input);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };
  const seller = (): Id<'Seller'> => uuid7() as Id<'Seller'>;

  const familyOf = new Map<string, string>();
  async function family(target: typeof market): Promise<string> {
    const known = familyOf.get(target.marketId);
    if (known !== undefined) return known;
    const familyId = uuid7();
    const revisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base(target),
      code: `f-${uuid7().slice(-10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_family_revisions', {
      id: revisionId,
      ...base(target),
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    familyOf.set(target.marketId, revisionId);
    return revisionId;
  }

  interface Category {
    readonly id: string;
    readonly name: string;
  }
  async function category(target: typeof market, names: Record<string, string>): Promise<Category> {
    const id = uuid7();
    const revisionId = uuid7();
    await owner.query(
      `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
      [target.marketId, target.tenantId],
    );
    await insert('platform_categories', {
      id,
      ...base(target),
      slug: `c-${uuid7().slice(-12)}`,
      parent_id: null,
      status: 'active',
      merged_into_id: null,
      vertical_root_code: null,
      published_revision_id: null,
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('platform_category_revisions', {
      id: revisionId,
      ...base(target),
      category_id: id,
      revision_no: 1,
      parent_id: null,
      change_kind: 'created',
      author_kind: 'seed',
      author_account_id: null,
      created_at: T0.toString(),
    });
    for (const [loc, name] of Object.entries(names)) {
      await insert('platform_category_revision_names', {
        ...base(target),
        revision_id: revisionId,
        locale: loc,
        name,
      });
    }
    await owner.query(
      `UPDATE catalog.platform_categories SET published_revision_id = $3
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, id, revisionId],
    );
    return { id, name: names[locale] ?? '' };
  }

  interface Made {
    readonly productId: Id<'Product'>;
    readonly productCode: string;
    readonly revisionId: string;
    photo(position: number, state?: 'clean' | 'taken-down'): Promise<string>;
  }
  interface Options {
    readonly status?: ProductStatus;
    readonly scope?: 'PLATFORM' | 'SELLER';
    readonly sellerId?: Id<'Seller'>;
    readonly name?: string | null;
    readonly code?: string;
    readonly categories?: readonly Category[];
    /** Never published: the revision is only pending. */
    readonly pendingOnly?: boolean;
    /** A published product the admin paused (catalog design 4.1a). */
    readonly paused?: boolean;
    readonly changedAt?: Temporal.Instant;
    readonly createdAt?: Temporal.Instant;
    readonly target?: typeof market;
  }

  async function make(options: Options = {}): Promise<Made> {
    const target = options.target ?? market;
    const status = options.status ?? 'published';
    const scope = options.scope ?? 'SELLER';
    const sellerId = scope === 'SELLER' ? (options.sellerId ?? seller()) : null;
    const productCode = options.code ?? `X${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope,
      sellerId,
      handler: simpleProductType,
      familyCode: 'default',
      productCode,
      variantId: uuid7() as Id<'Variant'>,
      now: options.createdAt ?? T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const productId = created.value.state.id;
    await run(target, () => products.add(target, created.value));
    const revisionId = uuid7();
    await insert('product_revisions', {
      id: revisionId,
      ...base(target),
      product_id: productId,
      revision_no: 1,
      revision_kind: 'submission',
      base_revision_id: null,
      reverted_from_revision_id: null,
      family_revision_id: await family(target),
      definition_revision_ids: [],
      tax_category_code: 'standard',
      attribute_values: '{}',
      field_provenance: null,
      sensitive: false,
      sensitive_reasons: [],
      content_schema_version: 1,
      content_hash: `sha256:${'1'.repeat(64)}`,
      author_kind: 'admin',
      author_account_id: uuid7(),
      acting_admin_account_id: null,
      submitted_at: T0.toString(),
    });
    const name = options.name === undefined ? 'Dates' : options.name;
    const targetLocale = policy.locales(target).default;
    if (name !== null) {
      await insert('product_revision_texts', {
        ...base(target),
        revision_id: revisionId,
        locale: targetLocale,
        name,
      });
    }
    for (const [index, entry] of (options.categories ?? []).entries()) {
      await insert('product_revision_categories', {
        ...base(target),
        revision_id: revisionId,
        category_id: entry.id,
        position: index + 1,
      });
    }
    const extra: Record<string, string> = {
      discarded: ', discarded_at = now()',
      withdrawn: ', withdrawn_at = now()',
      retired: ', retired_at = now()',
    };
    if (status === 'matched') {
      throw new Error('matched needs a target product: not made here');
    }
    const pointerless = status === 'draft' || status === 'discarded';
    await owner.query(
      `UPDATE catalog.products
          SET status = $3, ${options.pendingOnly === true ? 'pending_revision_id' : 'published_revision_id'} = $4,
              pending_submitted_at = $5, last_changed_at = $6${extra[status] ?? ''}
        WHERE market_id = $1 AND id = $2`,
      [
        target.marketId,
        productId,
        status,
        pointerless ? null : revisionId,
        options.pendingOnly === true && !pointerless ? T0.toString() : null,
        (options.changedAt ?? T0).toString(),
      ],
    );
    if (options.paused === true) {
      await owner.query(
        `UPDATE catalog.products SET paused_at = now(), paused_by_account_id = $3
          WHERE market_id = $1 AND id = $2`,
        [target.marketId, productId, uuid7()],
      );
    }
    return {
      productId,
      productCode,
      revisionId,
      async photo(position, state = 'clean'): Promise<string> {
        const id = uuid7();
        await insert('product_images', {
          ...base(target),
          id,
          product_id: productId,
          uploader_account_id: uuid7(),
          state: 'clean',
          pixel_width: 100,
          pixel_height: 100,
          byte_size: 10,
          created_at: T0.toString(),
        });
        await insert('product_image_renditions', {
          ...base(target),
          image_id: id,
          product_id: productId,
          size_code: 'thumb',
          object_key: `${productId}/${id}-thumb`,
          sha256: createHash('sha256').update(id).digest(),
          byte_size: 9,
          pixel_width: 100,
          pixel_height: 100,
        });
        await insert('product_revision_images', {
          ...base(target),
          revision_id: revisionId,
          product_id: productId,
          image_id: id,
          position,
        });
        if (state === 'taken-down') {
          await owner.query(
            `UPDATE catalog.product_images
                SET state = 'taken-down', taken_down_at = now(),
                    taken_down_by_account_id = $3, takedown_reason_code = 'misleading'
              WHERE market_id = $1 AND id = $2`,
            [market.marketId, id, uuid7()],
          );
        }
        return id;
      },
    };
  }

  async function offerOn(made: Made, sellerId: Id<'Seller'>, sku: string, deleted = false) {
    const offer = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: market.marketId,
      sellerId,
      productId: made.productId,
      sellerSku: sku,
      conditionCode: 'new',
      description: { [locale]: 'mine' },
      now: T0,
    });
    if (!offer.ok) throw new Error(offer.error.code);
    const refusal = await run(market, () =>
      offers.add(market, offer.value, { kind: 'seller', accountId: uuid7() as Id<'Account'> }),
    );
    if (refusal !== null && refusal !== undefined) throw new Error(JSON.stringify(refusal));
    if (deleted) {
      await owner.query(
        `UPDATE catalog.offers SET status = 'deleted', deleted_at = now(), listed = false
          WHERE market_id = $1 AND id = $2`,
        [market.marketId, offer.value.state.id],
      );
    }
  }

  it('lists both scopes of the Market with the tab counts, and nothing of another Market', async () => {
    const mine = seller();
    const marker = `Zq${uuid7().slice(-8)}`;
    const a = await make({ sellerId: mine, name: `${marker} published` });
    const platform = await make({ scope: 'PLATFORM', name: `${marker} platform` });
    const hidden = await make({ target: other, name: `${marker} canary` });

    const answer = await ask({ q: marker, view: 'all' });

    expect(answer.items.map((item) => item.productId).sort()).toEqual(
      [a.productId, platform.productId].sort(),
    );
    expect(answer.items.map((item) => item.productId)).not.toContain(hidden.productId);
    expect(answer.counts).toEqual({ active: 2, all: 2, inactive: 0 });
    expect(answer.total).toBe(2);
    const row = answer.items.find((item) => item.productId === platform.productId)!;
    expect(row).toMatchObject({ scope: 'PLATFORM', ownerSellerId: null, ownerStoreName: null });
    // The other Market sees its own canary and not ours.
    const theirs = await ask({ q: marker, view: 'all' }, other);
    expect(theirs.items.map((item) => item.productId)).toEqual([hidden.productId]);
  });

  it('puts statuses in their tabs: active is published, inactive unpublished and withdrawn, all adds retired, and drafts never show', async () => {
    const mine = seller();
    const published = await make({ sellerId: mine, status: 'published' });
    const pending = await make({ sellerId: mine, status: 'unpublished', pendingOnly: true });
    const withdrawn = await make({ sellerId: mine, status: 'withdrawn' });
    await make({ scope: 'PLATFORM', status: 'retired' });
    await make({ sellerId: mine, status: 'draft', pendingOnly: true });
    await make({ sellerId: mine, status: 'discarded', pendingOnly: true });

    const active = await ask({ sellerId: mine, view: 'active' });
    const inactive = await ask({ sellerId: mine, view: 'inactive' });
    const all = await ask({ sellerId: mine, view: 'all' });

    expect(active.items.map((i) => i.productId)).toEqual([published.productId]);
    expect(inactive.items.map((i) => i.productId).sort()).toEqual(
      [pending.productId, withdrawn.productId].sort(),
    );
    expect(all.items.map((i) => i.status).sort()).toEqual(
      ['published', 'unpublished', 'withdrawn'].sort(),
    );
    // The counts of every tab come with every answer.
    expect(active.counts).toEqual({ active: 1, all: 3, inactive: 2 });
    expect(all.counts).toEqual(active.counts);
    expect(all.total).toBe(3);
    // A status filter narrows the tabs.
    const narrowed = await ask({ sellerId: mine, view: 'all', status: 'withdrawn' });
    expect(narrowed.items.map((i) => i.productId)).toEqual([withdrawn.productId]);
    expect(narrowed.counts).toEqual({ active: 0, all: 1, inactive: 1 });
  });

  it('shows a paused product in the Inactive tab as Paused, not in Active, and filters by Paused', async () => {
    const mine = seller();
    const live = await make({ sellerId: mine, name: 'Live' });
    const paused = await make({ sellerId: mine, name: 'Paused one', paused: true });
    const withdrawn = await make({ sellerId: mine, status: 'withdrawn' });

    const active = await ask({ sellerId: mine, view: 'active' });
    const inactive = await ask({ sellerId: mine, view: 'inactive' });
    const all = await ask({ sellerId: mine, view: 'all' });

    expect(active.items.map((i) => i.productId)).toEqual([live.productId]);
    expect(inactive.items.map((i) => [i.productId, i.status]).sort()).toEqual(
      [
        [paused.productId, 'paused'],
        [withdrawn.productId, 'withdrawn'],
      ].sort(),
    );
    expect(all.items.map((i) => i.status).sort()).toEqual(['paused', 'published', 'withdrawn']);
    expect(all.counts).toEqual({ active: 1, all: 3, inactive: 2 });
    // The status filter tells paused from published, which are the same stored status.
    const onlyPaused = await ask({ sellerId: mine, view: 'all', status: 'paused' });
    const onlyPublished = await ask({ sellerId: mine, view: 'all', status: 'published' });
    expect(onlyPaused.items.map((i) => i.productId)).toEqual([paused.productId]);
    expect(onlyPublished.items.map((i) => i.productId)).toEqual([live.productId]);
    expect(onlyPaused.counts).toEqual({ active: 0, all: 1, inactive: 1 });
  });

  describe('the reads of the bulk action and the export', () => {
    it('answers which ids exist in this Market only, and their state with the Offer count', async () => {
      const mine = seller();
      const a = await make({ sellerId: mine });
      const b = await make({ sellerId: mine, paused: true });
      const platform = await make({ scope: 'PLATFORM' });
      const foreign = await make({ target: other });
      // One Offer per seller and product: three sellers, one of them deleted.
      await offerOn(a, mine, `SKU-${uuid7().slice(-8)}`);
      await offerOn(a, seller(), `SKU-${uuid7().slice(-8)}`);
      await offerOn(a, seller(), `SKU-${uuid7().slice(-8)}`, true);
      const reader = new PrismaAdminProductsReader(db.service);
      const wanted = [a.productId, b.productId, platform.productId, foreign.productId];

      const found = await run(market, () => reader.existing(market, wanted));
      const states = await run(market, () => reader.states(market, wanted));

      expect([...found].sort()).toEqual([a.productId, b.productId, platform.productId].sort());
      const byId = new Map(states.map((state) => [state.productId, state]));
      expect(byId.get(a.productId)).toMatchObject({
        scope: 'SELLER',
        status: 'published',
        paused: false,
        offerCount: 2,
      });
      expect(byId.get(b.productId)).toMatchObject({ paused: true, offerCount: 0 });
      expect(byId.get(platform.productId)).toMatchObject({ scope: 'PLATFORM', paused: false });
      expect(byId.has(foreign.productId)).toBe(false);
    });

    it('resolves a filter to ids, newest change first, at most the limit, and rows by id in order', async () => {
      const mine = seller();
      const old = await make({ sellerId: mine, changedAt: T0 });
      const newer = await make({ sellerId: mine, changedAt: T0.add({ hours: 1 }) });
      const newest = await make({ sellerId: mine, changedAt: T0.add({ hours: 2 }), paused: true });
      const reader = new PrismaAdminProductsReader(db.service);
      const filter = {
        matches: [
          { status: 'published' as const, paused: false },
          { status: 'published' as const, paused: true },
        ],
        scope: null,
        categoryId: null,
        typeCode: null,
        sellerId: mine,
        text: null,
        locale,
      };

      const idsAll = await run(market, () => reader.ids(market, filter, 10));
      const idsTwo = await run(market, () => reader.ids(market, filter, 2));
      const rows = await run(market, () =>
        reader.rowsByIds(market, [old.productId, newest.productId, newer.productId], locale),
      );

      expect(idsAll).toEqual([newest.productId, newer.productId, old.productId]);
      expect(idsTwo).toEqual([newest.productId, newer.productId]);
      expect(rows.map((row) => [row.productId, row.status])).toEqual([
        [old.productId, 'published'],
        [newest.productId, 'paused'],
        [newer.productId, 'published'],
      ]);
    });
  });

  it('searches the name in the Market locale, ignoring case, and the product code', async () => {
    const mine = seller();
    const marker = `Qx${uuid7().slice(-8)}`;
    const byName = await make({ sellerId: mine, name: `Lamb Cutlets ${marker}` });
    const byCode = await make({ sellerId: mine, name: 'Other', code: `C${marker.toUpperCase()}` });
    const pendingName = await make({
      sellerId: mine,
      status: 'unpublished',
      pendingOnly: true,
      name: `Pending ${marker}`,
    });
    await make({ sellerId: mine, name: 'Unrelated' });

    const hits = async (q: string) =>
      (await ask({ sellerId: mine, view: 'all', q })).items.map((i) => i.productId).sort();

    expect(await hits(`lamb cutlets ${marker.toLowerCase()}`)).toEqual([byName.productId]);
    expect(await hits(marker.toLowerCase())).toEqual(
      [byName.productId, byCode.productId, pendingName.productId].sort(),
    );
    expect(await hits(byCode.productCode.toLowerCase())).toEqual([byCode.productId]);
    expect(await hits('no-such-thing')).toEqual([]);
    // The counts follow the search.
    expect((await ask({ sellerId: mine, q: marker })).counts).toEqual({
      active: 2,
      all: 3,
      inactive: 1,
    });
  });

  it('matches a % or _ in the search as typed, not as a wildcard', async () => {
    const mine = seller();
    const exact = await make({ sellerId: mine, name: '100% fresh_juice' });
    await make({ sellerId: mine, name: '100 percent freshXjuice' });

    const percent = await ask({ sellerId: mine, view: 'all', q: '100%' });
    const underscore = await ask({ sellerId: mine, view: 'all', q: 'fresh_j' });
    const lone = await ask({ sellerId: mine, view: 'all', q: '%' });

    expect(percent.items.map((i) => i.productId)).toEqual([exact.productId]);
    expect(underscore.items.map((i) => i.productId)).toEqual([exact.productId]);
    expect(lone.items.map((i) => i.productId)).toEqual([exact.productId]);
  });

  it('filters by scope, seller, category and product type', async () => {
    const mine = seller();
    const marker = `Ft${uuid7().slice(-8)}`;
    const meat = await category(market, { [locale]: 'Meat' });
    const bakery = await category(market, { [locale]: 'Bakery' });
    const inMeat = await make({ sellerId: mine, name: `${marker} a`, categories: [meat] });
    const inBakery = await make({
      sellerId: mine,
      name: `${marker} b`,
      categories: [bakery, meat],
    });
    const platform = await make({ scope: 'PLATFORM', name: `${marker} c`, categories: [meat] });

    const ids = async (input: AdminProductsListInput) =>
      (await ask({ q: marker, view: 'all', ...input })).items.map((i) => i.productId).sort();

    expect(await ids({ scope: 'PLATFORM' })).toEqual([platform.productId]);
    expect(await ids({ scope: 'SELLER' })).toEqual([inMeat.productId, inBakery.productId].sort());
    expect(await ids({ sellerId: mine })).toEqual([inMeat.productId, inBakery.productId].sort());
    expect(await ids({ categoryId: bakery.id })).toEqual([inBakery.productId]);
    expect(await ids({ categoryId: meat.id })).toEqual(
      [inMeat.productId, inBakery.productId, platform.productId].sort(),
    );
    expect(await ids({ typeCode: 'simple' })).toHaveLength(3);
    expect(await ids({ typeCode: 'configurable' })).toEqual([]);
    // Filters narrow every tab count too.
    expect((await ask({ q: marker, scope: 'PLATFORM' })).counts).toEqual({
      active: 1,
      all: 1,
      inactive: 0,
    });
  });

  it('sorts by name (market collation, case-insensitive, nameless last), updated and created, and pages', async () => {
    const mine = seller();
    const names = ['banana', 'Apple', 'cherry', 'apple pie'];
    const made: Made[] = [];
    for (const [index, name] of names.entries()) {
      made.push(
        await make({
          sellerId: mine,
          name,
          changedAt: T0.add({ minutes: index }),
          createdAt: T0.subtract({ minutes: index }),
        }),
      );
    }
    const nameless = await make({ sellerId: mine, name: null, changedAt: T0.add({ minutes: 9 }) });
    const [banana, apple, cherry, applePie] = made as [Made, Made, Made, Made];

    const order = async (input: AdminProductsListInput) =>
      (await ask({ sellerId: mine, view: 'all', ...input })).items.map((i) => i.productId);

    expect(await order({ sort: 'name' })).toEqual([
      apple.productId,
      applePie.productId,
      banana.productId,
      cherry.productId,
      nameless.productId,
    ]);
    expect(await order({ sort: 'name', direction: 'desc' })).toEqual([
      cherry.productId,
      banana.productId,
      applePie.productId,
      apple.productId,
      nameless.productId,
    ]);
    expect(await order({ sort: 'updated' })).toEqual([
      nameless.productId,
      applePie.productId,
      cherry.productId,
      apple.productId,
      banana.productId,
    ]);
    expect(await order({ sort: 'updated', direction: 'asc' })).toEqual([
      banana.productId,
      apple.productId,
      cherry.productId,
      applePie.productId,
      nameless.productId,
    ]);
    // Created: the later the name in the list, the earlier it was created; ties by id.
    expect(await order({ sort: 'created', direction: 'asc' })).toEqual([
      applePie.productId,
      cherry.productId,
      apple.productId,
      banana.productId,
      nameless.productId,
    ]);

    const first = await ask({ sellerId: mine, view: 'all', sort: 'name', pageSize: 2 });
    const second = await ask({ sellerId: mine, view: 'all', sort: 'name', pageSize: 2, page: 2 });
    const third = await ask({ sellerId: mine, view: 'all', sort: 'name', pageSize: 2, page: 3 });
    const beyond = await ask({ sellerId: mine, view: 'all', sort: 'name', pageSize: 2, page: 4 });
    expect(first.items.map((i) => i.productId)).toEqual([apple.productId, applePie.productId]);
    expect(second.items.map((i) => i.productId)).toEqual([banana.productId, cherry.productId]);
    expect(third.items.map((i) => i.productId)).toEqual([nameless.productId]);
    expect(beyond.items).toEqual([]);
    expect([first.total, second.total, third.total, beyond.total]).toEqual([5, 5, 5, 5]);
    // The same product never lands on two pages of a date sort with equal dates.
    const sameDate = seller();
    const twins = [
      await make({ sellerId: sameDate, name: 'twin 1' }),
      await make({ sellerId: sameDate, name: 'twin 2' }),
      await make({ sellerId: sameDate, name: 'twin 3' }),
    ];
    const seen = [
      ...(await ask({ sellerId: sameDate, pageSize: 2, page: 1 })).items,
      ...(await ask({ sellerId: sameDate, pageSize: 2, page: 2 })).items,
    ].map((i) => i.productId);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(twins.map((t) => t.productId).sort());
  });

  it('shows the category name, the primary clean photo, the offer count and the store name', async () => {
    const mine = seller();
    storeNames = new Map([[mine, 'Halal Meats']]);
    const meat = await category(market, { [locale]: 'Meat', xx: 'Other tongue' });
    const first = await make({ sellerId: mine, categories: [meat] });
    const takenDown = await first.photo(1, 'taken-down');
    const primary = await first.photo(2);
    await first.photo(3);
    const bare = await make({ sellerId: mine, name: 'Bare' });
    await offerOn(first, mine, `SKU-${uuid7().slice(-6)}`);
    await offerOn(first, seller(), `SKU-${uuid7().slice(-6)}`);
    await offerOn(first, seller(), `SKU-${uuid7().slice(-6)}`, true);

    const answer = await ask({ sellerId: mine, view: 'all' });

    const row = answer.items.find((i) => i.productId === first.productId)!;
    expect(row).toMatchObject({
      productCode: first.productCode,
      name: 'Dates',
      categoryId: meat.id,
      categoryName: 'Meat',
      typeCode: 'simple',
      status: 'published',
      ownerSellerId: mine,
      ownerStoreName: 'Halal Meats',
      offerCount: 2,
    });
    // Position 1 is taken down: the next clean one is the primary.
    expect(row.primaryImageId).toBe(primary);
    expect(row.primaryImageId).not.toBe(takenDown);
    expect(row.updatedAt).toBe(T0.toString());
    expect(row.createdAt).toBe(T0.toString());
    const empty = answer.items.find((i) => i.productId === bare.productId)!;
    expect(empty).toMatchObject({
      categoryId: null,
      categoryName: null,
      primaryImageId: null,
      offerCount: 0,
    });
  });

  it('shows a never-published product with the name, category and photo of its pending revision', async () => {
    const mine = seller();
    const meat = await category(market, { [locale]: 'Meat' });
    const waiting = await make({
      sellerId: mine,
      status: 'unpublished',
      pendingOnly: true,
      name: 'Waiting for review',
      categories: [meat],
    });
    const photo = await waiting.photo(1);

    const answer = await ask({ sellerId: mine, view: 'inactive' });

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      productId: waiting.productId,
      name: 'Waiting for review',
      categoryName: 'Meat',
      primaryImageId: photo,
      status: 'unpublished',
    });
    // Filtering by that category finds it through the pending revision too.
    expect(
      (await ask({ sellerId: mine, view: 'inactive', categoryId: meat.id })).items,
    ).toHaveLength(1);
  });
});
