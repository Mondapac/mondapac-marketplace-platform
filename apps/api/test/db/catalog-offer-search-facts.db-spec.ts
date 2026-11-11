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
    revision?: {
      texts: Record<string, [string, string | null]>;
      categories: string[];
      /** The revision's attribute values by attribute code (attributes A7). */
      values?: Record<string, unknown>;
      /** The address of the brand the product carries. */
      brandSlug?: string;
    },
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
      attribute_values: JSON.stringify(revision.values ?? {}),
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
    if (revision.brandSlug !== undefined) {
      await owner.query(
        `UPDATE catalog.products SET brand_id = (SELECT id FROM catalog.brands WHERE slug = $3)
          WHERE market_id = $1 AND id = $2`,
        [target.marketId, created.value.state.id, revision.brandSlug],
      );
    }
    return created.value.state.id;
  }

  /** An attribute definition with one PUBLISHED revision (and its options); the code is the test's own. */
  async function definition(
    target: typeof market,
    code: string,
    kind: {
      dataType: string;
      status?: string;
      searchable?: boolean;
      canBeFilter?: boolean;
      names: Record<string, string>;
      options?: Record<string, { label: string; mergedInto?: string; active?: boolean }>;
    },
  ): Promise<void> {
    const base = { market_id: target.marketId, tenant_id: target.tenantId };
    const definitionId = uuid7();
    const revisionId = uuid7();
    await insert('attribute_definitions', {
      id: definitionId,
      ...base,
      code,
      data_type: kind.dataType,
      localizable: false,
      status: kind.status ?? 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_definition_revisions', {
      id: revisionId,
      ...base,
      definition_id: definitionId,
      revision_no: 1,
      material: false,
      is_variant_option: false,
      bounds: '{}',
      names: JSON.stringify(kind.names),
      searchable: kind.searchable ?? false,
      can_be_filter: kind.canBeFilter ?? false,
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    for (const [index, [optionCode, option]] of Object.entries(kind.options ?? {}).entries()) {
      await insert('attribute_definition_revision_options', {
        ...base,
        revision_id: revisionId,
        option_code: optionCode,
        labels: JSON.stringify({ 'en-AU': option.label, 'ja-JP': option.label }),
        active: option.active ?? true,
        position: index,
        merged_into: option.mergedInto ?? null,
      });
    }
    await owner.query(
      `UPDATE catalog.attribute_definitions SET published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, definitionId, revisionId],
    );
  }

  /** An active brand with aliases (brands are shared by every Market). */
  async function brand(name: string, aliases: string[], status = 'active'): Promise<string> {
    const brandId = uuid7();
    const slug = `fx-${uuid7().slice(-12)}`;
    await insert('brands', {
      id: brandId,
      slug,
      name,
      name_key: slug.replaceAll('-', ''),
      status,
      ...(status === 'draft' ? { proposed_by_seller_id: uuid7() } : {}),
      created_at: T0.toString(),
      updated_at: T0.toString(),
      version: 1,
    });
    for (const alias of aliases) {
      await insert('brand_aliases', {
        id: uuid7(),
        brand_id: brandId,
        alias,
        created_at: T0.toString(),
      });
    }
    return slug;
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
    sellerId: Id<'Seller'> = uuid7() as Id<'Seller'>,
  ): Promise<Id<'Offer'>> {
    const created = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: target.marketId,
      sellerId,
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

  it('gives the attribute facts of the published revision for the index (attributes A7)', async () => {
    const tag = uuid7().slice(-8);
    const [diet, size, organic, weight, note, hidden, draft] = [
      'diet',
      'size',
      'organic',
      'weight',
      'note',
      'hidden',
      'draftattr',
    ].map((name) => `${name}-${tag}`) as [string, string, string, string, string, string, string];
    await definition(market, diet, {
      dataType: 'multi-select',
      searchable: true,
      canBeFilter: true,
      names: { 'en-AU': 'Diet' },
      options: {
        halal: { label: 'Halal certified' },
        vegan: { label: 'Vegan' },
        'old-halal': { label: 'Old halal', mergedInto: 'halal' },
      },
    });
    await definition(market, size, {
      dataType: 'select',
      canBeFilter: true,
      names: { 'en-AU': 'Size' },
      options: { s: { label: 'Small' } },
    });
    await definition(market, organic, {
      dataType: 'boolean',
      canBeFilter: true,
      names: { 'en-AU': 'Organic' },
    });
    await definition(market, weight, {
      dataType: 'decimal',
      canBeFilter: true,
      names: { 'en-AU': 'Weight' },
    });
    await definition(market, note, {
      dataType: 'text',
      searchable: true,
      names: { 'en-AU': 'Note' },
    });
    await definition(market, hidden, { dataType: 'text', names: { 'en-AU': 'Hidden' } });
    await definition(market, draft, {
      dataType: 'text',
      status: 'draft',
      searchable: true,
      names: { 'en-AU': 'Draft' },
    });
    await definition(market, 'country-of-origin', {
      dataType: 'text',
      names: { 'en-AU': 'Country of origin' },
    }).catch(() => undefined); // another test of the Market may have made it
    const slug = await brand(`Al Safa ${tag}`, [`Alsafa${tag}`, `Al-Safa Foods ${tag}`]);
    const productId = await product(market, {
      texts: { 'en-AU': ['Dates', null] },
      categories: [],
      brandSlug: slug,
      values: {
        [diet]: ['halal', 'old-halal', 'vegan', 'gone'],
        [size]: 's',
        [organic]: true,
        [weight]: '12.5',
        [note]: 'Stone ground',
        [hidden]: 'Never indexed',
        [draft]: 'Draft words',
        'country-of-origin': 'Australia',
      },
    });
    const published = await offer(market, productId, 'published');

    const map = await run(market, () => reader.read(market, [published], 'en-AU'), true);
    const attributes = map.get(published)?.attributes;

    expect(attributes?.facets).toEqual(
      [
        `brand=${slug}`,
        `${diet}=halal`,
        `${diet}=vegan`,
        `${size}=s`,
        `${organic}=true`,
        'country-of-origin=au',
      ].sort(),
    );
    expect(attributes?.numbers).toEqual({ [weight]: 12.5 });
    const words = (attributes?.searchText ?? '').split(' ');
    expect(attributes?.searchText).toContain(`Al Safa ${tag}`);
    expect(attributes?.searchText).toContain(`Al-Safa Foods ${tag}`);
    expect(attributes?.searchText).toContain('Halal certified');
    expect(attributes?.searchText).toContain('Stone ground');
    expect(attributes?.searchText).toContain('Australia');
    // The merged option shows under its target only; the unsearchable and draft attributes are not text.
    expect(attributes?.searchText).not.toContain('Old halal');
    expect(words).not.toContain('Never');
    expect(attributes?.searchText).not.toContain('Draft words');
  });

  it('gives the published variants of a sellable Offer with axis facets, label and GTIN (variants V8)', async () => {
    const tag = uuid7().slice(-8);
    const size = `vsize-${tag}`;
    await definition(market, size, {
      dataType: 'select',
      canBeFilter: true,
      names: { 'en-AU': 'Size' },
      options: { s: { label: 'Small' }, 'old-s': { label: 'Old small', mergedInto: 's' } },
    });
    const productId = await product(market, { texts: { 'en-AU': ['Rice', null] }, categories: [] });
    const { rows } = await owner.query<{ id: string; revision: string }>(
      `SELECT v.id, p.published_revision_id AS revision
         FROM catalog.product_variants v JOIN catalog.products p
           ON p.market_id = v.market_id AND p.id = v.product_id
        WHERE v.market_id = $1 AND v.product_id = $2`,
      [market.marketId, productId],
    );
    const variantId = rows[0]!.id;
    await owner.query(
      `UPDATE catalog.product_variants SET state = 'published', published_at = now()
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, variantId],
    );
    await insert('product_revision_variants', {
      market_id: market.marketId,
      tenant_id: market.tenantId,
      revision_id: rows[0]!.revision,
      variant_id: variantId,
      product_id: productId,
      position: 0,
      option_key: `${size}=old-s`,
      option_values: JSON.stringify({ [size]: 'old-s' }),
      labels: JSON.stringify({ 'en-AU': `Small ${tag}` }),
      gtin: '09300633603366',
    });
    const sellable = await offer(market, productId, 'published');
    const draft = await offer(market, productId, 'draft');
    // A second seller's Offer that switched this variant off (V5), and a third that switched it
    // back on: a stored row with `selling = true` sells like no row.
    const switchedOff = await offer(market, productId, 'published');
    const switchedOn = await offer(market, productId, 'published');
    for (const [offerId, selling] of [
      [switchedOff, false],
      [switchedOn, true],
    ] as const) {
      const { rows: owners } = await owner.query<{ seller_id: string }>(
        'SELECT seller_id FROM catalog.offers WHERE market_id = $1 AND id = $2',
        [market.marketId, offerId],
      );
      await insert('offer_sell_units', {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        offer_id: offerId,
        seller_id: owners[0]!.seller_id,
        product_id: productId,
        variant_id: variantId,
        selling,
        version: 1,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    const map = await run(
      market,
      () => reader.read(market, [sellable, draft, switchedOff, switchedOn], 'en-AU'),
      true,
    );

    expect(map.get(sellable)?.variants).toEqual([
      {
        variantId,
        position: 0,
        label: `Small ${tag}`,
        gtin: '09300633603366',
        facets: [`${size}=s`],
      },
    ]);
    expect(map.get(sellable)?.attributes.searchText).toContain(`Small ${tag}`);
    // An Offer that is not sellable carries no variants.
    expect(map.get(draft)?.variants).toEqual([]);
    // A switched-off sell unit is not indexed for its Offer: no facet, label word or GTIN.
    expect(map.get(switchedOff)?.sellable).toBe(true);
    expect(map.get(switchedOff)?.variants).toEqual([]);
    expect(map.get(switchedOff)?.attributes.searchText ?? '').not.toContain(`Small ${tag}`);
    expect(map.get(switchedOn)?.variants).toEqual(map.get(sellable)?.variants);
  });

  it('indexes the values of a merged attribute as its target, with the option map (attributes A8)', async () => {
    const tag = uuid7().slice(-8);
    const [pack, container] = [`pack-${tag}`, `container-${tag}`];
    await definition(market, container, {
      dataType: 'select',
      canBeFilter: true,
      names: { 'en-AU': 'Container' },
      options: { tin: { label: 'Tin' }, jar: { label: 'Jar' } },
    });
    await definition(market, pack, {
      dataType: 'select',
      canBeFilter: true,
      names: { 'en-AU': 'Pack type' },
      options: { can: { label: 'Can' } },
    });
    const idOf = async (attribute: string) =>
      (
        await owner.query<{ id: string }>(
          'SELECT id FROM catalog.attribute_definitions WHERE market_id = $1 AND code = $2',
          [market.marketId, attribute],
        )
      ).rows[0]!.id;
    const [sourceId, targetId] = [await idOf(pack), await idOf(container)];
    await owner.query(
      `INSERT INTO catalog.attribute_merge_options (market_id, tenant_id, source_id, source_code, target_code)
       VALUES ($1, $2, $3, 'can', 'tin')`,
      [market.marketId, market.tenantId, sourceId],
    );
    await owner.query(
      `UPDATE catalog.attribute_definitions SET status = 'archived', merged_into_id = $3, version = version + 1
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, sourceId, targetId],
    );
    const onlySource = await product(market, {
      texts: { 'en-AU': ['Beans', null] },
      categories: [],
      values: { [pack]: 'can' },
    });
    const both = await product(market, {
      texts: { 'en-AU': ['Peas', null] },
      categories: [],
      values: { [pack]: 'can', [container]: 'jar' },
    });
    const first = await offer(market, onlySource, 'published');
    const second = await offer(market, both, 'published');
    const map = await run(market, () => reader.read(market, [first, second], 'en-AU'), true);
    expect(map.get(first)?.attributes.facets).toEqual([`${container}=tin`]);
    // The target's own value wins when a product carries both.
    expect(map.get(second)?.attributes.facets).toEqual([`${container}=jar`]);
  });

  it('gives a stamp that holds while nothing changes and changes with a definition or a brand', async () => {
    const stampOf = (target: typeof market) =>
      run(target, () => reader.searchIndexStamp(target), true);
    const before = await stampOf(market);
    expect(await stampOf(market)).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{32}$/);

    await definition(market, `stamp-${uuid7().slice(-8)}`, {
      dataType: 'select',
      canBeFilter: true,
      names: { 'en-AU': 'Stamp' },
    });
    const afterDefinition = await stampOf(market);
    expect(afterDefinition).not.toBe(before);

    await brand('Stamp brand', []);
    expect(await stampOf(market)).not.toBe(afterDefinition);
  });

  it('indexes no brand for a draft or archived brand, and nothing for a product with no revision', async () => {
    const draftBrand = await brand('Draft Brand', [`Dbrand${uuid7().slice(-8)}`], 'draft');
    const productId = await product(market, {
      texts: { 'en-AU': ['Unbranded now', null] },
      categories: [],
      brandSlug: draftBrand,
    });
    const published = await offer(market, productId, 'published');
    const bare = await offer(market, await product(market), 'published');

    const map = await run(market, () => reader.read(market, [published, bare], 'en-AU'), true);

    expect(map.get(published)?.attributes).toEqual({ searchText: '', facets: [], numbers: {} });
    expect(map.get(bare)?.attributes).toEqual({ searchText: '', facets: [], numbers: {} });
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

  it("lists one seller's published Offers only, in id order", async () => {
    const sellerId = uuid7() as Id<'Seller'>;
    const a = await offer(market, await product(market), 'published', sellerId);
    const b = await offer(market, await product(market), 'published', sellerId);
    await offer(market, await product(market), 'draft', sellerId);
    await offer(market, await product(market), 'published');
    await offer(other, await product(other), 'published', sellerId);

    const ofSeller = await run(
      market,
      () => reader.publishedOfferIds(market, { sellerId, limit: 10 }),
      true,
    );

    expect(ofSeller).toEqual([a, b].sort());
  });
});
