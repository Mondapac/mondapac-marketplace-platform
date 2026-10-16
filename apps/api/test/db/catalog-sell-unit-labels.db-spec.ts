import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { sellUnitKey } from '../../src/modules/catalog/contracts/catalog.facade';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaSellUnitLabelsReader } from '../../src/modules/catalog/infrastructure/prisma-sell-unit-labels.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// `sellUnitLabels` reader on PostgreSQL, for both Market fixtures: the PUBLISHED revision's
// product name and Variant label only (a newer unpublished revision is never read), the locale
// fallback, a product with no published revision, and the Market boundary (canary).

const T0 = Temporal.Instant.from('2026-10-16T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)('catalog sell-unit labels in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;
  let reader: PrismaSellUnitLabelsReader;
  const actor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    offers = new PrismaOfferRepository(db.service, ids);
    reader = new PrismaSellUnitLabelsReader(db.service);
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
        tax_category_code: 'standard',
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

  const read = (
    keys: readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'> }[],
    locale = 'en-AU',
  ) => run(market, () => reader.read(market, keys, locale), true);

  it('returns the published name and label, never a newer unpublished revision', async () => {
    const a = await unit(
      market,
      { texts: { 'en-AU': 'Dates' }, labels: { 'en-AU': '500 g' } },
      { texts: { 'en-AU': 'DRAFT NAME' }, labels: { 'en-AU': 'DRAFT LABEL' } },
    );
    const answer = await read([a]);
    expect(answer.get(sellUnitKey(a))).toEqual({ productName: 'Dates', variantLabel: '500 g' });
    expect(JSON.stringify([...answer])).not.toContain('DRAFT');
  });

  it('falls back to another locale, and gives a null label when the revision has none', async () => {
    const a = await unit(market, { texts: { xx: 'Fallback name' }, labels: { xx: 'Fallback' } });
    const b = await unit(market, { texts: { 'en-AU': 'Plain' }, labels: {} });
    const answer = await read([a, b]);
    expect(answer.get(sellUnitKey(a))).toEqual({
      productName: 'Fallback name',
      variantLabel: 'Fallback',
    });
    expect(answer.get(sellUnitKey(b))).toEqual({ productName: 'Plain', variantLabel: null });
  });

  it('omits a product with no published revision, however much draft content it has', async () => {
    const a = await unit(market, null, {
      texts: { 'en-AU': 'DRAFT ONLY' },
      labels: { 'en-AU': 'x' },
    });
    expect((await read([a])).size).toBe(0);
  });

  it('omits an unknown Offer and an Offer of another Market (canary), and a foreign Variant gets no label', async () => {
    const foreign = await unit(other, {
      texts: { 'en-AU': 'CANARY' },
      labels: { 'en-AU': 'CANARY' },
    });
    const mine = await unit(market, { texts: { 'en-AU': 'Mine' }, labels: { 'en-AU': 'L' } });
    const unknown = { offerId: uuid7() as Id<'Offer'>, variantId: uuid7() as Id<'Variant'> };
    const answer = await read([foreign, unknown, mine]);
    expect([...answer.keys()]).toEqual([sellUnitKey(mine)]);
    expect(JSON.stringify([...answer])).not.toContain('CANARY');
    const crossVariant = await read([{ offerId: mine.offerId, variantId: foreign.variantId }]);
    expect(
      crossVariant.get(sellUnitKey({ offerId: mine.offerId, variantId: foreign.variantId })),
    ).toEqual({ productName: 'Mine', variantLabel: null });
  });
});
