import { randomUUID } from 'node:crypto';
import type { Id } from '@mondapac/shared-kernel';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaOwnCatalogReader } from '../../src/modules/catalog/infrastructure/prisma-own-catalog.reader';
import { PrismaPlatformProductSearchReader } from '../../src/modules/catalog/infrastructure/prisma-platform-product-search.reader';
import type { PlatformProductSearchQuery } from '../../src/modules/catalog/application/ports/platform-product-search.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// PrismaPlatformProductSearchReader (seller "Add offer" search) on PostgreSQL, for both Market
// fixtures: scope (published, unpaused, PLATFORM, in the seller's categories), the text match
// (name, code, brand, category name, GTIN), LIKE wildcards typed by a person, the already-selling
// flag, the barcode lookup and the Market boundary.

const NOW = '2026-10-08T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
/** A tag no other row of the shared database can contain (`zq` is not a hex digit pair). */
/** A 14-digit code unique to the run (the reader matches the stored value exactly). */
const gtin = () => String(Math.floor(Math.random() * 1e14)).padStart(14, '1');
const tag = () => `zq${randomUUID().replaceAll('-', '').slice(0, 8)}`;

describe.each(TEST_MARKETS)('platform product search reader in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let app: Client;
  let reader: PrismaPlatformProductSearchReader;
  let ownReader: PrismaOwnCatalogReader;

  const SELLER = uuid7() as Id<'Seller'>;
  const RIVAL = uuid7() as Id<'Seller'>;

  async function insert(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await app.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }
  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });

  const families = new Map<string, string>();
  async function familyRevision(m = market): Promise<string> {
    const known = families.get(m.marketId);
    if (known !== undefined) return known;
    const familyId = uuid7();
    const revisionId = uuid7();
    await app.query(
      `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
      [m.marketId, m.tenantId],
    );
    await insert('attribute_families', {
      id: familyId,
      ...base(m),
      code: `f-${randomUUID().slice(0, 10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: NOW,
    });
    await insert('attribute_family_revisions', {
      id: revisionId,
      ...base(m),
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: NOW,
    });
    families.set(m.marketId, revisionId);
    return revisionId;
  }

  async function variantOf(productId: string, m = market, no = 1): Promise<string> {
    const id = uuid7();
    await insert('product_variants', {
      id,
      ...base(m),
      product_id: productId,
      variant_model: 'single',
      state: 'published',
      created_at: NOW,
      published_at: NOW,
      variant_no: no,
    });
    return id;
  }

  async function category(name: string, m = market): Promise<string> {
    const id = uuid7();
    const revisionId = uuid7();
    await insert('platform_categories', {
      id,
      ...base(m),
      slug: `s-${randomUUID().slice(0, 12)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: NOW,
      // -1: the database takes the next free position (one per parent and Market, trigger).
      position: -1,
    });
    await insert('platform_category_revisions', {
      id: revisionId,
      ...base(m),
      category_id: id,
      revision_no: 1,
      change_kind: 'created',
      author_kind: 'seed',
      created_at: NOW,
    });
    await insert('platform_category_revision_names', {
      ...base(m),
      revision_id: revisionId,
      locale: 'en',
      name,
    });
    await app.query(
      'UPDATE catalog.platform_categories SET published_revision_id = $1 WHERE id = $2',
      [revisionId, id],
    );
    return id;
  }

  async function brand(name: string, status = 'active'): Promise<string> {
    const id = uuid7();
    await insert('brands', {
      id,
      slug: `b-${randomUUID().slice(0, 12)}`,
      name,
      name_key: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
      status,
      created_at: NOW,
      updated_at: NOW,
      version: 1,
    });
    return id;
  }

  interface ProductOptions {
    readonly name: string;
    readonly categoryIds: readonly string[];
    readonly gtin?: string;
    readonly scope?: 'PLATFORM' | 'SELLER';
    readonly status?: string;
    readonly paused?: boolean;
    readonly published?: boolean;
    readonly brandId?: string;
    readonly market?: typeof market;
    readonly code?: string;
  }

  async function product(options: ProductOptions): Promise<{ id: string; code: string }> {
    const m = options.market ?? market;
    const id = uuid7();
    const revisionId = uuid7();
    const productCode =
      options.code ?? `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const scope = options.scope ?? 'PLATFORM';
    await insert('products', {
      id,
      ...base(m),
      scope,
      owner_seller_id: scope === 'SELLER' ? RIVAL : null,
      created_by_seller_id: scope === 'SELLER' ? RIVAL : null,
      type_code: 'simple',
      variant_model: 'single',
      family_code: 'default',
      product_code: productCode,
      status: 'draft',
      own_brand: false,
      last_changed_at: NOW,
      version: 1,
      created_at: NOW,
      brand_id: options.brandId ?? null,
    });
    await insert('product_revisions', {
      id: revisionId,
      ...base(m),
      product_id: id,
      revision_no: 1,
      revision_kind: 'submission',
      family_revision_id: await familyRevision(m),
      tax_category_code: 't1',
      attribute_values: '{}',
      sensitive: false,
      content_schema_version: 1,
      content_hash: `sha256:${'a'.repeat(64)}`,
      definition_revision_ids: [],
      sensitive_reasons: [],
      author_kind: 'admin',
      author_account_id: uuid7(),
      submitted_at: NOW,
      type_code: 'simple',
    }).catch((error: unknown) => {
      throw error;
    });
    await insert('product_revision_texts', {
      ...base(m),
      revision_id: revisionId,
      locale: 'en',
      name: options.name,
    });
    let position = 0;
    for (const categoryId of options.categoryIds) {
      await insert('product_revision_categories', {
        ...base(m),
        revision_id: revisionId,
        category_id: categoryId,
        position,
        is_primary: position === 0,
      });
      position += 1;
    }
    await insert('product_revision_variants', {
      ...base(m),
      revision_id: revisionId,
      variant_id: await variantOf(id, m),
      product_id: id,
      position: 0,
      option_key: 'default',
      option_values: '{}',
      labels: '{}',
      gtin: options.gtin ?? null,
    });
    if (options.published !== false) {
      await app.query(
        `UPDATE catalog.products SET status = 'published', published_revision_id = $1,
           paused_at = $3, paused_by_account_id = $4 WHERE id = $2`,
        [
          revisionId,
          id,
          options.paused === true ? NOW : null,
          options.paused === true ? uuid7() : null,
        ],
      );
    }
    return { id, code: productCode };
  }

  async function offer(productId: string, sellerId: string, status = 'published'): Promise<void> {
    await insert('offers', {
      id: uuid7(),
      ...base(),
      seller_id: sellerId,
      product_id: productId,
      seller_sku: `sku-${randomUUID().slice(0, 8)}`,
      condition_code: 'new',
      description: '{}',
      status,
      off_sale_type_not_allowed: false,
      off_sale_product_retired: false,
      off_sale_product_not_listed: false,
      off_sale_tag_suspended: false,
      off_sale_description_claim_text: false,
      listed: status === 'published',
      handling: 'SEALED_ORIGINAL',
      first_published_at: status === 'published' ? NOW : null,
      deleted_at: status === 'deleted' ? NOW : null,
      version: 1,
      created_at: NOW,
      off_sale_product_paused: false,
    });
  }

  const search = (
    overrides: Partial<PlatformProductSearchQuery> & {
      allowed: readonly string[];
    },
  ) =>
    persistence.unitOfWork
      .run(
        market,
        async () => ({
          ok: true as const,
          value: await reader.search(market, {
            sellerId: SELLER,
            allowedCategoryIds: new Set(overrides.allowed as Id<'Category'>[]),
            locale: 'en',
            text: overrides.text ?? null,
            gtins: overrides.gtins ?? [],
            notSelling: overrides.notSelling ?? false,
            offset: overrides.offset ?? 0,
            limit: overrides.limit ?? 25,
          }),
        }),
        { readOnly: true },
      )
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });
  const lookup = (allowed: readonly string[], gtins: readonly string[]) =>
    persistence.unitOfWork
      .run(
        market,
        async () => ({
          ok: true as const,
          value: await reader.lookupGtins(market, {
            sellerId: SELLER,
            allowedCategoryIds: new Set(allowed as Id<'Category'>[]),
            locale: 'en',
            gtins,
          }),
        }),
        { readOnly: true },
      )
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });

  beforeAll(async () => {
    persistence = createPersistence();
    app = new Client({ connectionString: testDatabaseUrl() });
    await app.connect();
    reader = new PrismaPlatformProductSearchReader(persistence.service);
    ownReader = new PrismaOwnCatalogReader(persistence.service);
  });
  afterAll(async () => {
    await app.end();
    await persistence.close();
  });

  it('returns only published, unpaused PLATFORM products inside the allowed categories', async () => {
    const t = tag();
    const inside = await category(`${t} cat`);
    const outside = await category(`${t} elsewhere`);
    const good = await product({ name: `${t} good`, categoryIds: [inside] });
    await product({ name: `${t} paused`, categoryIds: [inside], paused: true });
    await product({ name: `${t} draft`, categoryIds: [inside], published: false, status: 'draft' });
    await product({ name: `${t} seller`, categoryIds: [inside], scope: 'SELLER' });
    await product({ name: `${t} outside`, categoryIds: [outside] });
    const page = await search({ allowed: [inside], text: t });
    expect(page.rows.map((row) => row.productId)).toEqual([good.id]);
    expect(page.total).toBe(1);
  });

  /** A photo of the product's published revision at `position`, taken down when asked. */
  async function photo(productId: string, position: number, takenDown = false): Promise<string> {
    const id = uuid7();
    const revisionId = (
      await app.query<{ published_revision_id: string }>(
        'SELECT published_revision_id FROM catalog.products WHERE id = $1',
        [productId],
      )
    ).rows[0]!.published_revision_id;
    await insert('product_images', {
      id,
      ...base(),
      product_id: productId,
      uploader_account_id: uuid7(),
      state: 'clean',
      pixel_width: 800,
      pixel_height: 800,
      byte_size: 1000,
      created_at: NOW,
    });
    await insert('product_revision_images', {
      ...base(),
      revision_id: revisionId,
      product_id: productId,
      image_id: id,
      position,
    });
    if (takenDown) {
      await app.query(
        `UPDATE catalog.product_images SET state = 'taken-down', taken_down_at = now(),
           taken_down_by_account_id = $2, takedown_reason_code = 'other' WHERE id = $1`,
        [id, uuid7()],
      );
    }
    return id;
  }

  it('gives each row the first clean photo of the published revision as its thumbnail', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    const withPhotos = await product({ name: `${t} a photos`, categoryIds: [c] });
    await photo(withPhotos.id, 1, true);
    const second = await photo(withPhotos.id, 2);
    await photo(withPhotos.id, 3);
    const without = await product({ name: `${t} b none`, categoryIds: [c] });
    const page = await search({ allowed: [c], text: t });
    const imageOf = new Map(page.rows.map((row) => [row.productId, row.primaryImageId]));
    // The taken-down first photo is skipped: the next one in position order is the thumbnail.
    expect(imageOf.get(withPhotos.id as Id<'Product'>)).toBe(second);
    expect(imageOf.get(without.id as Id<'Product'>)).toBeNull();
  });

  it('gives the Offer lists the product scope and the same thumbnail (productLabels)', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    const platform = await product({ name: `${t} platform`, categoryIds: [c] });
    const first = await photo(platform.id, 1);
    await photo(platform.id, 2);
    const own = await product({ name: `${t} own`, categoryIds: [c], scope: 'SELLER' });
    const ownPhoto = await photo(own.id, 1);
    const bare = await product({ name: `${t} bare`, categoryIds: [c] });
    const unpublished = await product({ name: `${t} unpub`, categoryIds: [c], published: false });
    const labels = await persistence.unitOfWork
      .run(
        market,
        async () => ({
          ok: true as const,
          value: await ownReader.productLabels(
            market,
            [platform.id, own.id, bare.id, unpublished.id] as Id<'Product'>[],
            'en',
          ),
        }),
        { readOnly: true },
      )
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });
    const byId = new Map(labels.map((label) => [label.productId as string, label]));
    expect(byId.get(platform.id)).toMatchObject({ scope: 'PLATFORM', primaryImageId: first });
    expect(byId.get(own.id)).toMatchObject({ scope: 'SELLER', primaryImageId: ownPhoto });
    expect(byId.get(bare.id)?.primaryImageId).toBeNull();
    // No published revision: no name and no thumbnail.
    expect(byId.get(unpublished.id)).toMatchObject({ name: null, primaryImageId: null });
    // The other Market sees none of them.
    const elsewhere = await persistence.unitOfWork
      .run(
        other,
        async () => ({
          ok: true as const,
          value: await ownReader.productLabels(other, [platform.id] as Id<'Product'>[], 'en'),
        }),
        { readOnly: true },
      )
      .then((result) => (result.ok ? result.value : []));
    expect(elsewhere).toEqual([]);
  });

  it('fails closed with no allowed category', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    await product({ name: `${t} p`, categoryIds: [c] });
    expect(await search({ allowed: [], text: t })).toEqual({ rows: [], total: 0 });
  });

  it('matches name, product code, brand and category name; not another product', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    const b = await brand(`${t}brand`);
    const byName = await product({ name: `Shoe ${t}`, categoryIds: [c] });
    const byBrand = await product({ name: 'Plain', categoryIds: [c], brandId: b });
    const inactive = await brand(`${t}dormant`, 'archived');
    await product({ name: 'Other', categoryIds: [c], brandId: inactive });
    const names = await search({ allowed: [c], text: `Shoe ${t}` });
    expect(names.rows.map((r) => r.productId)).toEqual([byName.id]);
    const brandHit = await search({ allowed: [c], text: `${t}brand` });
    expect(brandHit.rows.map((r) => r.productId)).toEqual([byBrand.id]);
    expect(brandHit.rows[0]?.brandName).toBe(`${t}brand`);
    const codeHit = await search({ allowed: [c], text: byName.code.toLowerCase() });
    expect(codeHit.rows.map((r) => r.productId)).toEqual([byName.id]);
    const archivedBrand = await search({ allowed: [c], text: `${t}dormant` });
    expect(archivedBrand.rows).toHaveLength(0);
    // The category name matches every product of the category (inside the allowed set only).
    const viaCategory = await search({ allowed: [c], text: `${t} cat` });
    expect(viaCategory.total).toBe(3);
  });

  it('matches a typed barcode through its 14-digit form', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    const stored = `0${String(Math.floor(Math.random() * 1e13)).padStart(13, '2')}`;
    const hit = await product({ name: `${t} gtin`, categoryIds: [c], gtin: stored });
    const page = await search({ allowed: [c], text: stored.slice(1), gtins: [stored] });
    expect(page.rows.map((r) => r.productId)).toEqual([hit.id]);
  });

  it('treats % and _ typed by a person as plain characters (not wildcards)', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    await product({ name: `${t} alpha`, categoryIds: [c] });
    await product({ name: `${t} beta`, categoryIds: [c] });
    // A literal percent sign, underscore and backslash exist in no name: nothing may match.
    expect((await search({ allowed: [c], text: '%' })).total).toBe(0);
    expect((await search({ allowed: [c], text: '_' })).total).toBe(0);
    expect((await search({ allowed: [c], text: `${t} a_pha` })).total).toBe(0);
    expect((await search({ allowed: [c], text: `${t}%alpha` })).total).toBe(0);
  });

  it('flags a product the seller already sells, ignoring deleted offers and other sellers', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    const mine = await product({ name: `${t} mine`, categoryIds: [c] });
    const deleted = await product({ name: `${t} deleted`, categoryIds: [c] });
    const theirs = await product({ name: `${t} theirs`, categoryIds: [c] });
    await offer(mine.id, SELLER);
    await offer(deleted.id, SELLER, 'deleted');
    await offer(theirs.id, RIVAL);
    const page = await search({ allowed: [c], text: t });
    const flag = new Map(page.rows.map((r) => [r.productId as string, r.alreadySelling]));
    expect(flag.get(mine.id)).toBe(true);
    expect(flag.get(deleted.id)).toBe(false);
    expect(flag.get(theirs.id)).toBe(false);
  });

  it('leaves out and does not count the products the seller sells when notSelling is set', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    const mine = await product({ name: `${t} mine`, categoryIds: [c] });
    const deleted = await product({ name: `${t} deleted`, categoryIds: [c] });
    const theirs = await product({ name: `${t} theirs`, categoryIds: [c] });
    const free = await product({ name: `${t} free`, categoryIds: [c] });
    await offer(mine.id, SELLER);
    await offer(mine.id, SELLER, 'deleted');
    await offer(deleted.id, SELLER, 'deleted');
    await offer(theirs.id, RIVAL);
    const page = await search({ allowed: [c], text: t, notSelling: true });
    expect(page.total).toBe(3);
    expect(new Set(page.rows.map((r) => r.productId as string))).toEqual(
      new Set([deleted.id, theirs.id, free.id]),
    );
    expect(page.rows.every((r) => !r.alreadySelling)).toBe(true);
    const all = await search({ allowed: [c], text: t });
    expect(all.total).toBe(4);
  });

  it('pages a listing with a stable order and the full total', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    for (let i = 0; i < 5; i += 1) await product({ name: `${t} n${i}`, categoryIds: [c] });
    const first = await search({ allowed: [c], limit: 2, offset: 0 });
    const second = await search({ allowed: [c], limit: 2, offset: 2 });
    expect(first.total).toBe(5);
    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(2);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.productId)).size).toBe(4);
  });

  it('never returns another Market product, even when its category id is allowed', async () => {
    const t = tag();
    const c = await category(`${t} cat`);
    const foreignCategory = await category(`${t} cat`, other);
    await product({ name: `${t} foreign`, categoryIds: [foreignCategory], market: other });
    expect((await search({ allowed: [c, foreignCategory], text: t })).total).toBe(0);
  });

  it('answers a barcode lookup with scope, already-selling and Market isolation', async () => {
    const t = tag();
    const [g17, g24, g31, g48, g55] = [gtin(), gtin(), gtin(), gtin(), gtin()];
    const c = await category(`${t} cat`);
    const away = await category(`${t} away`);
    const inScope = await product({ name: `${t} in`, categoryIds: [c], gtin: g17 });
    const outScope = await product({ name: `${t} out`, categoryIds: [away], gtin: g24 });
    await product({ name: `${t} paused`, categoryIds: [c], gtin: g31, paused: true });
    await product({ name: `${t} seller`, categoryIds: [c], gtin: g48, scope: 'SELLER' });
    const foreign = await category(`${t} f`, other);
    await product({ name: `${t} fm`, categoryIds: [foreign], gtin: g55, market: other });
    await offer(inScope.id, SELLER);
    const matches = await lookup([c], [g17, g24, g31, g48, g55]);
    const byGtin = new Map(matches.map((m) => [m.gtin, m]));
    expect(byGtin.get(g17)).toMatchObject({ inScope: true });
    expect(byGtin.get(g17)?.row.alreadySelling).toBe(true);
    expect(byGtin.get(g24)).toMatchObject({ inScope: false });
    expect(byGtin.get(g24)?.row.productId).toBe(outScope.id);
    expect(byGtin.has(g31)).toBe(false);
    expect(byGtin.has(g48)).toBe(false);
    expect(byGtin.has(g55)).toBe(false);
  });

  it('ignores a GTIN that only an older, unpublished revision carries', async () => {
    const t = tag();
    const [old, fresh] = [gtin(), gtin()];
    const c = await category(`${t} cat`);
    const p = await product({ name: `${t} p`, categoryIds: [c], gtin: old });
    // A newer pending revision that is not the published one.
    const pending = uuid7();
    await insert('product_revisions', {
      id: pending,
      ...base(),
      product_id: p.id,
      revision_no: 2,
      revision_kind: 'submission',
      family_revision_id: await familyRevision(),
      tax_category_code: 't1',
      attribute_values: '{}',
      sensitive: false,
      content_schema_version: 1,
      content_hash: `sha256:${'a'.repeat(64)}`,
      definition_revision_ids: [],
      sensitive_reasons: [],
      author_kind: 'admin',
      author_account_id: uuid7(),
      submitted_at: NOW,
      type_code: 'simple',
    });
    await insert('product_revision_variants', {
      ...base(),
      revision_id: pending,
      variant_id: (
        await app.query<{ id: string }>(
          'SELECT id FROM catalog.product_variants WHERE product_id = $1',
          [p.id],
        )
      ).rows[0]!.id,
      product_id: p.id,
      position: 0,
      option_key: 'default',
      option_values: '{}',
      labels: '{}',
      gtin: fresh,
    });
    expect(await lookup([c], [fresh])).toEqual([]);
    expect(await lookup([c], [old])).toHaveLength(1);
  });
});
