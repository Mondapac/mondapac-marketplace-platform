import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaOfferSearchFactsReader } from '../../src/modules/catalog/infrastructure/prisma-offer-search-facts.reader';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The reads catalog gives the search index (offerSearchFacts, publishedOfferIds) on PostgreSQL,
// for both Market fixtures: the published revision's text in the asked locale, its categories,
// the sellable flag, keyset pages, and the Market boundary.

const T0 = Temporal.Instant.from('2026-10-15T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)('catalog search facts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;
  let reader: PrismaOfferSearchFactsReader;
  const actor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    offers = new PrismaOfferRepository(db.service, ids);
    reader = new PrismaOfferSearchFactsReader(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>, readOnly = false) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), { readOnly });
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

  /** A PLATFORM product, with a published revision (texts per locale, categories) when asked. */
  async function product(
    target: typeof market,
    revision?: { texts: Record<string, [string, string | null]>; categories: string[] },
  ): Promise<Id<'Product'>> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `S${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await run(target, () => products.add(target, created.value));
    if (revision === undefined) return created.value.state.id;
    const base = { market_id: target.marketId, tenant_id: target.tenantId };
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    const revisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base,
      code: `f-${uuid7().slice(-10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_family_revisions', {
      id: familyRevisionId,
      ...base,
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    await insert('product_revisions', {
      id: revisionId,
      ...base,
      product_id: created.value.state.id,
      revision_no: 1,
      revision_kind: 'submission',
      base_revision_id: null,
      reverted_from_revision_id: null,
      family_revision_id: familyRevisionId,
      definition_revision_ids: [],
      tax_category_code: 'standard',
      attribute_values: '{}',
      field_provenance: null,
      sensitive: false,
      sensitive_reasons: [],
      content_schema_version: 1,
      content_hash: `sha256:${'a'.repeat(64)}`,
      author_kind: 'admin',
      author_account_id: uuid7(),
      acting_admin_account_id: null,
      submitted_at: T0.toString(),
    });
    for (const [locale, [name, short]] of Object.entries(revision.texts)) {
      await insert('product_revision_texts', {
        ...base,
        revision_id: revisionId,
        locale,
        name,
        short_description: short,
        description: null,
      });
    }
    for (const [position, categoryId] of revision.categories.entries()) {
      await insert('product_revision_categories', {
        ...base,
        revision_id: revisionId,
        category_id: categoryId,
        position,
      });
    }
    await owner.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, created.value.state.id, revisionId],
    );
    return created.value.state.id;
  }

  async function category(target: typeof market): Promise<string> {
    const categoryId = uuid7();
    await insert('platform_categories', {
      id: categoryId,
      market_id: target.marketId,
      tenant_id: target.tenantId,
      parent_id: null,
      vertical_root_code: null,
      slug: `c-${categoryId.slice(-10)}`,
      status: 'active',
      merged_into_id: null,
      published_revision_id: null,
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    return categoryId;
  }

  async function offer(
    target: typeof market,
    productId: Id<'Product'>,
    state: 'draft' | 'published',
  ): Promise<Id<'Offer'>> {
    const created = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: target.marketId,
      sellerId: uuid7() as Id<'Seller'>,
      productId,
      sellerSku: `SKU-${uuid7().slice(-12)}`,
      conditionCode: 'new',
      description: { en: 'Fresh' },
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await run(target, () => offers.add(target, created.value, actor));
    if (state === 'published') {
      await owner.query(
        `UPDATE catalog.offers
            SET status = 'published', listed = true, handling = 'SEALED_ORIGINAL',
                attestation_recorded_at = now(), attestation_account_id = $3,
                submitted_at = now(), first_published_at = now()
          WHERE market_id = $1 AND id = $2`,
        [target.marketId, created.value.state.id, uuid7()],
      );
    }
    return created.value.state.id;
  }

  it('gives the text of the published revision in the asked locale, with its categories in order', async () => {
    const first = await category(market);
    const second = await category(market);
    const productId = await product(market, {
      texts: { 'en-AU': ['Halal sausages', 'Twelve pack'], 'ja-JP': ['Sosēji', null] },
      categories: [second, first],
    });
    const published = await offer(market, productId, 'published');

    const map = await run(market, () => reader.read(market, [published], 'en-AU'), true);
    const japanese = await run(market, () => reader.read(market, [published], 'ja-JP'), true);
    const missing = await run(market, () => reader.read(market, [published], 'fr-FR'), true);

    expect(map.get(published)).toMatchObject({
      productId,
      sellable: true,
      text: { locale: 'en-AU', name: 'Halal sausages', shortDescription: 'Twelve pack' },
      categoryIds: [second, first],
    });
    expect(japanese.get(published)?.text).toEqual({
      locale: 'ja-JP',
      name: 'Sosēji',
      shortDescription: null,
    });
    expect(missing.get(published)?.text).toBeNull();
  });

  it('marks an Offer that is not published as not sellable, and a product without a revision as text-less', async () => {
    const withText = await product(market, { texts: { 'en-AU': ['Named', null] }, categories: [] });
    const draft = await offer(market, withText, 'draft');
    const bare = await offer(market, await product(market), 'published');

    const map = await run(market, () => reader.read(market, [draft, bare], 'en-AU'), true);

    expect(map.get(draft)).toMatchObject({ sellable: false, text: { name: 'Named' } });
    expect(map.get(bare)).toMatchObject({ sellable: true, text: null, categoryIds: [] });
  });

  it('omits unknown ids and the other Market, byte-identically', async () => {
    const foreignProduct = await product(other, {
      texts: { 'en-AU': ['Foreign', null] },
      categories: [],
    });
    const foreign = await offer(other, foreignProduct, 'published');

    const map = await run(
      market,
      () => reader.read(market, [foreign, uuid7() as Id<'Offer'>], 'en-AU'),
      true,
    );

    expect(map.size).toBe(0);
  });

  it('lists published Offers in id order with keyset pages, optionally of one product', async () => {
    const productId = await product(market, { texts: { 'en-AU': ['P', null] }, categories: [] });
    const a = await offer(market, productId, 'published');
    const b = await offer(market, productId, 'published');
    const c = await offer(market, await product(market), 'published');
    await offer(market, productId, 'draft');
    await offer(other, await product(other), 'published');
    const wanted = [a, b, c].sort();

    const all: Id<'Offer'>[] = [];
    let after: Id<'Offer'> | undefined;
    for (;;) {
      const page = await run(
        market,
        () =>
          reader.publishedOfferIds(market, { limit: 2, ...(after === undefined ? {} : { after }) }),
        true,
      );
      all.push(...page);
      if (page.length < 2) break;
      after = page[page.length - 1];
    }
    const ofProduct = await run(
      market,
      () => reader.publishedOfferIds(market, { productId, limit: 10 }),
      true,
    );

    expect(all.filter((offerId) => wanted.includes(offerId))).toEqual(wanted);
    expect([...all].sort()).toEqual(all);
    expect(ofProduct).toEqual([a, b].sort());
  });
});
