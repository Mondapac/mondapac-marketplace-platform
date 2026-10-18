import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaOfferTaxCategoriesReader } from '../../src/modules/catalog/infrastructure/prisma-offer-tax-categories.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// `offerTaxCategories` reader on PostgreSQL, for both Market fixtures: the PUBLISHED revision's
// tax category only (a newer unpublished revision is never read), a product with no published
// revision, and the Market boundary (canary).

const T0 = Temporal.Instant.from('2026-10-16T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)('catalog offer tax categories in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;
  let reader: PrismaOfferTaxCategoriesReader;
  const actor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    offers = new PrismaOfferRepository(db.service, ids);
    reader = new PrismaOfferTaxCategoriesReader(db.service);
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

  interface Spec {
    texts: Record<string, string>;
    labels: Record<string, string>;
    tax: string;
  }

  /** A product with an Offer; `published` becomes the published revision, `draft` a newer one. */
  async function unit(
    target: typeof market,
    published: Spec | null,
    draft: Spec | null = null,
  ): Promise<{ offerId: Id<'Offer'>; variantId: Id<'Variant'> }> {
    const variantId = uuid7() as Id<'Variant'>;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `L${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const productId = created.value.state.id;
    await run(target, () => products.add(target, created.value));
    const base = { market_id: target.marketId, tenant_id: target.tenantId };
    const familyId = uuid7();
    const familyRevisionId = uuid7();
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
    const revision = async (no: number, spec: Spec): Promise<string> => {
      const revisionId = uuid7();
      await insert('product_revisions', {
        id: revisionId,
        ...base,
        product_id: productId,
        revision_no: no,
        revision_kind: 'submission',
        base_revision_id: null,
        reverted_from_revision_id: null,
        family_revision_id: familyRevisionId,
        definition_revision_ids: [],
        tax_category_code: spec.tax,
        attribute_values: '{}',
        field_provenance: null,
        sensitive: false,
        sensitive_reasons: [],
        content_schema_version: 1,
        content_hash: `sha256:${String(no).repeat(64)}`,
        author_kind: 'admin',
        author_account_id: uuid7(),
        acting_admin_account_id: null,
        submitted_at: T0.toString(),
      });
      for (const [locale, name] of Object.entries(spec.texts)) {
        await insert('product_revision_texts', { ...base, revision_id: revisionId, locale, name });
      }
      await insert('product_revision_variants', {
        ...base,
        revision_id: revisionId,
        variant_id: variantId,
        product_id: productId,
        position: 0,
        option_key: 'size=l',
        option_values: '{"size":"l"}',
        labels: JSON.stringify(spec.labels),
      });
      return revisionId;
    };
    if (published !== null) {
      const revisionId = await revision(1, published);
      await owner.query(
        `UPDATE catalog.products SET status = 'published', published_revision_id = $3
           WHERE market_id = $1 AND id = $2`,
        [target.marketId, productId, revisionId],
      );
    }
    if (draft !== null) await revision(2, draft);
    const offer = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: target.marketId,
      sellerId: uuid7() as Id<'Seller'>,
      productId,
      sellerSku: `SKU-${uuid7().slice(-12)}`,
      conditionCode: 'new',
      description: { en: 'Fresh' },
      now: T0,
    });
    if (!offer.ok) throw new Error(offer.error.code);
    await run(target, () => offers.add(target, offer.value, actor));
    return { offerId: offer.value.state.id, variantId };
  }

  const read = (offerIds: readonly Id<'Offer'>[]) =>
    run(market, () => reader.read(market, offerIds), true);
  const spec = (tax: string): Spec => ({ texts: { 'en-AU': 'Dates' }, labels: {}, tax });

  it('returns the published category, never a newer unpublished revision', async () => {
    const a = await unit(market, spec('published_cat'), spec('draft_cat'));
    const answer = await read([a.offerId]);
    expect(answer.get(a.offerId)).toBe('published_cat');
    expect(JSON.stringify([...answer])).not.toContain('draft_cat');
  });

  it('answers each requested Offer with its own product category', async () => {
    const a = await unit(market, spec('cat_a'));
    const b = await unit(market, spec('cat_b'));
    const answer = await read([a.offerId, b.offerId]);
    expect(Object.fromEntries(answer)).toEqual({ [a.offerId]: 'cat_a', [b.offerId]: 'cat_b' });
  });

  it('omits a product with no published revision, however much draft content it has', async () => {
    const a = await unit(market, null, spec('draft_only'));
    expect((await read([a.offerId])).size).toBe(0);
  });

  it('omits a deleted Offer, as offerSellUnits does', async () => {
    const live = await unit(market, spec('live_cat'));
    const gone = await unit(market, spec('gone_cat'));
    await owner.query(
      `UPDATE catalog.offers SET status = 'deleted', deleted_at = now()
         WHERE market_id = $1 AND id = $2`,
      [market.marketId, gone.offerId],
    );
    const answer = await read([live.offerId, gone.offerId]);
    expect([...answer.keys()]).toEqual([live.offerId]);
  });

  it('omits an unknown Offer and an Offer of another Market (canary)', async () => {
    const foreign = await unit(other, spec('canary_cat'));
    const mine = await unit(market, spec('mine'));
    const unknown = uuid7() as Id<'Offer'>;
    const answer = await read([foreign.offerId, unknown, mine.offerId]);
    expect([...answer.keys()]).toEqual([mine.offerId]);
    expect(JSON.stringify([...answer])).not.toContain('canary_cat');
  });
});
