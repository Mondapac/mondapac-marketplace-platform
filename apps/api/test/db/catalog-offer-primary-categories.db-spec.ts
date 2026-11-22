import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { OfferPrimaryCategoriesQuery } from '../../src/modules/catalog/application/use-cases/offer-primary-categories.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferPrimaryCategoriesReader } from '../../src/modules/catalog/infrastructure/prisma-offer-primary-categories.reader';
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

// The primary category of each Offer that reporting reads of catalog (dashboards upgrade phase 3)
// on PostgreSQL, for both Market fixtures: the PUBLISHED revision's primary category, a deleted
// Offer still answered, a product with no published revision absent, another Market's Offer
// absent, the request bound, and the `system` rule (Hassan, PR 10 findings 2 and 1).

const T0 = Temporal.Instant.from('2026-11-15T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('catalog offer primary categories in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;
  let query: OfferPrimaryCategoriesQuery;
  const actor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    offers = new PrismaOfferRepository(db.service, ids);
    query = new OfferPrimaryCategoriesQuery(gate, {
      unitOfWork: db.unitOfWork,
      primaryCategoriesReader: new PrismaOfferPrimaryCategoriesReader(db.service),
    });
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

  /** A PLATFORM product; with `categories`, a published revision whose primary is `primary`. */
  async function product(
    target: typeof market,
    revision?: { categories: string[]; primary: string },
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
      type_code: 'simple',
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
    for (const [position, categoryId] of revision.categories.entries()) {
      await insert('product_revision_categories', {
        ...base,
        revision_id: revisionId,
        category_id: categoryId,
        position,
        is_primary: categoryId === revision.primary,
      });
    }
    await owner.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, created.value.state.id, revisionId],
    );
    return created.value.state.id;
  }

  async function offer(target: typeof market, productId: Id<'Product'>): Promise<Id<'Offer'>> {
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
    return created.value.state.id;
  }

  const ask = async (offerIds: readonly string[], context = testCallContext(market, 'system')) =>
    query.execute(context, { offerIds });

  it('answers the primary category of the published revision, a deleted Offer included', async () => {
    const [first, second] = [await category(market), await category(market)];
    const productId = await product(market, { categories: [first, second], primary: second });
    const live = await offer(market, productId);
    const gone = await offer(market, productId);
    await owner.query(
      `UPDATE catalog.offers SET status = 'deleted', deleted_at = now()
         WHERE market_id = $1 AND id = $2`,
      [market.marketId, gone],
    );
    const unpublished = await offer(market, await product(market));

    const answer = await ask([live, gone, unpublished, uuid7()]);
    if (!answer.ok) throw new Error(answer.error.code);
    expect([...answer.value.entries()].sort()).toEqual(
      [
        [live, second],
        [gone, second],
      ].sort(),
    );
  });

  it("never answers another Market's Offer", async () => {
    const elsewhere = await category(other);
    const theirs = await offer(
      other,
      await product(other, { categories: [elsewhere], primary: elsewhere }),
    );
    const answer = await ask([theirs]);
    expect(answer.ok && answer.value.size).toBe(0);
  });

  it('refuses more than 200 ids and a human actor', async () => {
    const tooMany = await ask(Array.from({ length: 201 }, () => uuid7()));
    expect(!tooMany.ok && tooMany.error.code).toBe('batch.too-large');
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const denied = await ask([uuid7()], admin);
    expect(!denied.ok && denied.error.code).toBe('access.denied');
  });
});
