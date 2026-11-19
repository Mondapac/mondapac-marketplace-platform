import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import type { ProductStatus } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaSellerImportFactsReader } from '../../src/modules/catalog/infrastructure/prisma-seller-import-facts.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The facts the seller import's check and run read (catalog design 14c), on PostgreSQL for both
// Market fixtures: a `Product code` finds only a published, unretired, unpaused PLATFORM product of
// this Market, and every other code (a SELLER product, one never published, retired, paused, of
// another Market, unknown) is absent in the same way (the byte-identical `product.not-found`); a
// Seller SKU finds only the asking seller's own Offer, so two sellers with the same SKU never see
// each other's.

const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('seller import facts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let offers: PrismaOfferRepository;
  let reader: PrismaSellerImportFactsReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    offers = new PrismaOfferRepository(db.service, {
      next: <K extends string>() => uuid7() as Id<K>,
    });
    reader = new PrismaSellerImportFactsReader(db.service);
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

  interface Options {
    readonly status?: ProductStatus;
    readonly scope?: 'PLATFORM' | 'SELLER';
    readonly sellerId?: Id<'Seller'>;
    readonly code?: string;
    readonly paused?: boolean;
    readonly target?: typeof market;
  }
  async function make(options: Options = {}) {
    const target = options.target ?? market;
    const status = options.status ?? 'published';
    const scope = options.scope ?? 'PLATFORM';
    const sellerId = scope === 'SELLER' ? (options.sellerId ?? (uuid7() as Id<'Seller'>)) : null;
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
      now: T0,
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
      type_code: 'simple',
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
    const pointerless = status === 'draft' || status === 'discarded';
    const extra: Record<string, string> = {
      retired: ', retired_at = now()',
      withdrawn: ', withdrawn_at = now()',
    };
    await owner.query(
      `UPDATE catalog.products
          SET status = $3, published_revision_id = $4, last_changed_at = $5${extra[status] ?? ''}
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, productId, status, pointerless ? null : revisionId, T0.toString()],
    );
    if (options.paused === true) {
      await owner.query(
        `UPDATE catalog.products SET paused_at = now(), paused_by_account_id = $3
          WHERE market_id = $1 AND id = $2`,
        [target.marketId, productId, uuid7()],
      );
    }
    return { productId, productCode };
  }

  async function offerOn(productId: Id<'Product'>, sellerId: Id<'Seller'>, sku: string) {
    const offer = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: market.marketId,
      sellerId,
      productId,
      sellerSku: sku,
      conditionCode: 'new',
      description: {},
      now: T0,
    });
    if (!offer.ok) throw new Error(offer.error.code);
    const refusal = await run(market, () =>
      offers.add(market, offer.value, { kind: 'seller', accountId: uuid7() as Id<'Account'> }),
    );
    if (refusal !== null && refusal !== undefined) throw new Error(JSON.stringify(refusal));
    return offer.value.state.id;
  }

  const load = (sellerId: Id<'Seller'>, skus: string[], productCodes: string[]) =>
    run(market, () => reader.load(market, sellerId, { skus, productCodes }));

  it('finds a published PLATFORM product by its code and answers every other code the same way', async () => {
    const good = await make();
    const sellerOwned = await make({ scope: 'SELLER' });
    const draft = await make({ status: 'draft' });
    const unpublished = await make({ status: 'unpublished' });
    const retired = await make({ status: 'retired' });
    const paused = await make({ paused: true });
    // The same code exists in the other Market: it is not found from this one.
    const sharedCode = `Y${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`;
    await make({ code: sharedCode, target: other });
    const unknown = 'NOSUCH00001';

    const facts = await load(
      uuid7() as Id<'Seller'>,
      [],
      [
        good.productCode,
        sellerOwned.productCode,
        draft.productCode,
        unpublished.productCode,
        retired.productCode,
        paused.productCode,
        sharedCode,
        unknown,
      ],
    );
    expect([...facts.catalogueByCode.keys()]).toEqual([good.productCode]);
    expect(facts.catalogueByCode.get(good.productCode)).toEqual({
      productId: good.productId,
      typeCode: 'simple',
    });
    // No distinction is available to the caller for the others: all are simply absent.
    for (const absent of [
      sellerOwned,
      draft,
      unpublished,
      retired,
      paused,
      { productCode: sharedCode },
      { productCode: unknown },
    ]) {
      expect(facts.catalogueByCode.has(absent.productCode)).toBe(false);
    }
  });

  it('finds the Offer of the asking seller only, with its product code, even for the same SKU', async () => {
    const a = uuid7() as Id<'Seller'>;
    const b = uuid7() as Id<'Seller'>;
    const productA = await make({ scope: 'SELLER', sellerId: a });
    const productB = await make({ scope: 'SELLER', sellerId: b });
    const offerA = await offerOn(productA.productId, a, 'SAME-SKU');
    const offerB = await offerOn(productB.productId, b, 'SAME-SKU');

    const forA = await load(a, ['SAME-SKU'], []);
    const forB = await load(b, ['SAME-SKU'], []);
    expect(forA.offersBySku.get('SAME-SKU')).toMatchObject({
      offerId: offerA,
      productId: productA.productId,
      productCode: productA.productCode,
      productScope: 'SELLER',
    });
    expect(forB.offersBySku.get('SAME-SKU')).toMatchObject({
      offerId: offerB,
      productId: productB.productId,
      productCode: productB.productCode,
    });
    // A third seller sees neither.
    const stranger = await load(uuid7() as Id<'Seller'>, ['SAME-SKU'], []);
    expect(stranger.offersBySku.size).toBe(0);
    // Nor does another Market.
    const elsewhere = await run(other, () =>
      reader.load(other, a, { skus: ['SAME-SKU'], productCodes: [] }),
    );
    expect(elsewhere.offersBySku.size).toBe(0);
  });
});
