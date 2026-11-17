import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AddSizes } from '../../src/modules/catalog/application/products/add-sizes.service';
import type { AttributeRepository } from '../../src/modules/catalog/application/ports/attribute.repository';
import type { AllowedProductTypes } from '../../src/modules/catalog/application/ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../../src/modules/catalog/application/ports/catalog-market-policy';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaRateCounterRepository } from '../../src/modules/catalog/infrastructure/prisma-rate-counter.repository';
import { PrismaWorkingCopyRepository } from '../../src/modules/catalog/infrastructure/prisma-working-copy.repository';
import { fixedFamilyResolver } from '../support/family-resolver';
import { PRICING_FIXTURES } from '../support/pricing-fixtures';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Add sizes (catalog design 4.2a, M-9) end to end on PostgreSQL, for both Market fixtures: the
// real `AddSizes` service over the real product, working copy, revision, Offer and rate-counter
// stores. What is faked is only what lives outside the catalog tables: the feature set read, the
// allowed types of a seller (SEL-12), the outbox and the audit writer. Proved: the variant keeps
// its id and number, and the price and the stock of its Offers (module `pricing` and `inventory`
// rows keyed on the variant id) are not touched; on a PLATFORM product the Offer of a seller who
// may not sell `configurable` gets the cause `type-not-allowed`, written by the admin.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const clock = new FixedClock(T0);
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

const option = (code: string) => ({ code, labels: { en: code } });
const SCHEMA = {
  schemaRef: { familyCode: 'default', familyRevisionId: 'f1', definitionRevisionIds: [] },
  fields: [
    {
      code: 'size',
      dataType: 'select' as const,
      localizable: false,
      required: false,
      isVariantOption: true,
      material: false,
      claimChecked: true as const,
      bounds: { options: ['s', 'm', 'l'].map(option) },
    },
  ],
};

describe.each(TEST_MARKETS)('Add sizes service in market %s (database)', (code) => {
  const market = marketOf(code);
  const currency = PRICING_FIXTURES.find((fixture) => fixture.code === code)!.policy.currency;
  const OWNER_SELLER = uuid7() as Id<'Seller'>;
  const ALLOWED_SELLER = uuid7() as Id<'Seller'>;
  const REFUSED_SELLER = uuid7() as Id<'Seller'>;
  const allowedTypes = new Map<string, AllowedProductTypes | null>([
    [OWNER_SELLER, 'all'],
    [ALLOWED_SELLER, 'all'],
    [REFUSED_SELLER, new Set(['simple'])],
  ]);
  let db: Persistence;
  let owner: Client;
  let service: AddSizes;
  let events: string[];
  let audits: { action: string }[];

  const policy: CatalogMarketPolicy = {
    taxCategoryCodes: () => ['t1'],
    locales: () => ({ default: 'en', supported: ['en'] }),
    maxVariantsPerProduct: () => 10,
    maxVariantAttributes: () => 2,
    productTypes: () => ['simple', 'configurable'],
    defaultFamily: () => 'default',
  } as unknown as CatalogMarketPolicy;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    const offers = new PrismaOfferRepository(db.service, {
      next: <K extends string>() => uuid7() as Id<K>,
    });
    service = new AddSizes({
      unitOfWork: db.unitOfWork,
      products: new PrismaProductRepository(db.service),
      workingCopies: new PrismaWorkingCopyRepository(db.service),
      revisions: new PrismaProductRevisionRepository(db.service),
      offers,
      offerFinder: offers,
      attributes: {
        loadSchema: () => Promise.resolve(SCHEMA),
        familyCodeOfRevision: () => Promise.resolve('default'),
      } as unknown as AttributeRepository,
      familyResolver: fixedFamilyResolver(),
      policy,
      allowedTypes: {
        allowedFor: (_context, sellerId) => Promise.resolve(allowedTypes.get(sellerId) ?? null),
      },
      counters: new PrismaRateCounterRepository(db.service),
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
      outbox: {
        append: (_context, pending) => {
          events.push(...pending.map((event) => event.type));
          return Promise.resolve();
        },
      },
      audit: {
        record: (_context, entry) => {
          audits.push({ action: entry.action });
          return Promise.resolve();
        },
      },
      clock,
    });
  });
  beforeEach(() => {
    events = [];
    audits = [];
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const actorContext = (population: 'seller' | 'admin', sellerId: Id<'Seller'> | null) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: uuid7() as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId,
      }),
    );
  const input = (productId: Id<'Product'>, extra: { offOfferCount?: number | null } = {}) => ({
    productId,
    version: 1,
    axes: ['size'],
    optionValues: { size: 'm' },
    replacePending: false,
    offOfferCount: extra.offOfferCount ?? null,
  });

  async function newProduct(
    scope: 'SELLER' | 'PLATFORM',
  ): Promise<{ id: Id<'Product'>; variantId: Id<'Variant'> }> {
    const variantId = uuid7() as Id<'Variant'>;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope,
      sellerId: scope === 'SELLER' ? OWNER_SELLER : null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `S${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const products = new PrismaProductRepository(db.service);
    await db.unitOfWork.run(market, async () => ok(await products.add(market, created.value)));
    return { id: created.value.state.id, variantId };
  }

  /** A published Offer, with a price series, one accepted regular price and a stock item. */
  async function sellingOffer(
    productId: Id<'Product'>,
    variantId: Id<'Variant'>,
    sellerId: Id<'Seller'>,
  ): Promise<Id<'Offer'>> {
    const offerId = uuid7() as Id<'Offer'>;
    const at = T0.toString();
    const base = { market_id: market.marketId, tenant_id: market.tenantId };
    await insert('catalog.offers', {
      id: offerId,
      ...base,
      seller_id: sellerId,
      product_id: productId,
      seller_sku: `SKU-${offerId.slice(-8)}`,
      condition_code: 'new',
      description: '{}',
      handling: 'SEALED_ORIGINAL',
      status: 'published',
      off_sale_type_not_allowed: false,
      off_sale_product_retired: false,
      off_sale_product_not_listed: false,
      off_sale_tag_suspended: false,
      off_sale_product_paused: false,
      off_sale_description_claim_text: false,
      listed: true,
      submitted_at: at,
      first_published_at: at,
      version: 3,
      created_at: at,
    });
    const seriesId = uuid7();
    await insert('pricing.price_series', {
      id: seriesId,
      ...base,
      offer_id: offerId,
      variant_id: variantId,
      product_id: productId,
      seller_id: sellerId,
      currency,
      version: 1,
      created_at: at,
    });
    await insert('pricing.regular_price_records', {
      id: uuid7(),
      ...base,
      series_id: seriesId,
      amount_minor: '1250',
      currency,
      tax_inclusive: true,
      status: 'accepted',
      submitted_at: at,
      submitted_by_account_id: uuid7(),
      effective_from: at,
    });
    const sourceId = await sourceOf(sellerId);
    await insert('inventory.stock_items', {
      id: uuid7(),
      ...base,
      offer_id: offerId,
      variant_id: variantId,
      source_id: sourceId,
      seller_id: sellerId,
      on_hand: 7,
      version: 1,
      created_at: at,
    });
    return offerId;
  }
  /** The seller's inventory and its one source, made on first use. */
  const sources = new Map<string, string>();
  async function sourceOf(sellerId: Id<'Seller'>): Promise<string> {
    const known = sources.get(sellerId);
    if (known !== undefined) return known;
    const at = T0.toString();
    const base = { market_id: market.marketId, tenant_id: market.tenantId };
    await insert('inventory.seller_inventories', {
      id: uuid7(),
      ...base,
      seller_id: sellerId,
      version: 1,
      created_at: at,
    });
    const sourceId = uuid7();
    await owner.query(
      `INSERT INTO inventory.sources (id, market_id, tenant_id, seller_id, name, is_default, priority, created_at)
       VALUES ($1, $2, $3, $4, 'Main', true, 1, $5)`,
      [sourceId, market.marketId, market.tenantId, sellerId, at],
    );
    sources.set(sellerId, sourceId);
    return sourceId;
  }
  async function insert(table: string, row: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(row);
    await owner.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  /** Every price and stock row of the Offers, whole, in a stable order. */
  async function moneyAndStock(offerIds: string[]) {
    const rows = async (text: string): Promise<unknown[]> =>
      (await owner.query<Record<string, unknown>>(text, [offerIds])).rows;
    return {
      series: await rows(
        'SELECT to_jsonb(t) AS row FROM pricing.price_series t WHERE offer_id = ANY($1::uuid[]) ORDER BY id',
      ),
      prices: await rows(
        `SELECT to_jsonb(r) AS row FROM pricing.regular_price_records r
          WHERE series_id IN (SELECT id FROM pricing.price_series WHERE offer_id = ANY($1::uuid[]))
          ORDER BY id`,
      ),
      stock: await rows(
        'SELECT to_jsonb(t) AS row FROM inventory.stock_items t WHERE offer_id = ANY($1::uuid[]) ORDER BY id',
      ),
    };
  }
  const variantsOf = async (productId: string): Promise<Record<string, unknown>[]> =>
    (
      await owner.query<Record<string, unknown>>(
        'SELECT id, variant_no, variant_model, state FROM catalog.product_variants WHERE market_id = $1 AND product_id = $2 ORDER BY id',
        [market.marketId, productId],
      )
    ).rows;
  const productRow = async (productId: string) =>
    (
      await owner.query(
        'SELECT type_code, variant_model, version FROM catalog.products WHERE market_id = $1 AND id = $2',
        [market.marketId, productId],
      )
    ).rows[0] as { type_code: string; variant_model: string; version: number };

  it('changes a SELLER product and leaves the price, the stock, the variant id and its number alone', async () => {
    const { id, variantId } = await newProduct('SELLER');
    const offerId = await sellingOffer(id, variantId, OWNER_SELLER);
    const before = await moneyAndStock([offerId]);
    expect(before.series).toHaveLength(1);
    expect(before.prices).toHaveLength(1);
    expect(before.stock).toHaveLength(1);
    const variantsBefore = await variantsOf(id);

    const result = await service.execute(actorContext('seller', OWNER_SELLER), input(id));

    expect(result).toEqual({
      ok: true,
      value: {
        productId: id,
        variantId,
        version: 2,
        offOfferCount: 0,
        supersededRevisionId: null,
      },
    });
    expect(await productRow(id)).toEqual({
      type_code: 'configurable',
      variant_model: 'options',
      version: 2,
    });
    const variantsAfter = await variantsOf(id);
    expect(variantsAfter).toEqual([{ ...variantsBefore[0], variant_model: 'options' }]);
    expect(variantsAfter[0]).toMatchObject({ id: variantId, variant_no: 1 });
    expect(await moneyAndStock([offerId])).toEqual(before);
    // The Offer itself is untouched too: still published and listed, no cause.
    const offer = await owner.query(
      'SELECT status, listed, off_sale_type_not_allowed, version FROM catalog.offers WHERE market_id = $1 AND id = $2',
      [market.marketId, offerId],
    );
    expect(offer.rows[0]).toEqual({
      status: 'published',
      listed: true,
      off_sale_type_not_allowed: false,
      version: 3,
    });
    expect(events).toEqual(['catalog.product-type-changed.v1']);
    expect(audits).toEqual([{ action: 'catalog.product.type-changed' }]);
    const copy = await owner.query<{ content: unknown }>(
      'SELECT content FROM catalog.product_working_copies WHERE market_id = $1 AND product_id = $2',
      [market.marketId, id],
    );
    expect(copy.rows[0]!.content).toMatchObject({
      variantAxes: ['size'],
      variants: [{ variantId, optionValues: { size: 'm' } }],
    });
  });

  it('changes a PLATFORM product, takes the Offer of a seller who may not sell it off sale and leaves every price and stock alone', async () => {
    const { id, variantId } = await newProduct('PLATFORM');
    const allowedOffer = await sellingOffer(id, variantId, ALLOWED_SELLER);
    const refusedOffer = await sellingOffer(id, variantId, REFUSED_SELLER);
    const before = await moneyAndStock([allowedOffer, refusedOffer]);
    expect(before.stock).toHaveLength(2);
    const variantsBefore = await variantsOf(id);
    const admin = actorContext('admin', null);

    const result = await service.execute(admin, input(id, { offOfferCount: 1 }));

    expect(result).toMatchObject({
      ok: true,
      value: { productId: id, variantId, offOfferCount: 1 },
    });
    expect(await productRow(id)).toMatchObject({
      type_code: 'configurable',
      variant_model: 'options',
    });
    const variantsAfter = await variantsOf(id);
    expect(variantsAfter).toEqual([{ ...variantsBefore[0], variant_model: 'options' }]);
    expect(variantsAfter[0]).toMatchObject({ id: variantId, variant_no: 1 });
    expect(await moneyAndStock([allowedOffer, refusedOffer])).toEqual(before);

    const offers = await owner.query(
      `SELECT id, listed, status, off_sale_type_not_allowed FROM catalog.offers
        WHERE market_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
      [market.marketId, [allowedOffer, refusedOffer]],
    );
    const byId = new Map(offers.rows.map((row: { id: string }) => [row.id, row]));
    expect(byId.get(allowedOffer)).toMatchObject({
      listed: true,
      status: 'published',
      off_sale_type_not_allowed: false,
    });
    // The cause is type-not-allowed and the Offer is off sale, but it keeps its status.
    expect(byId.get(refusedOffer)).toMatchObject({
      listed: false,
      status: 'published',
      off_sale_type_not_allowed: true,
    });
    const history = await owner.query(
      `SELECT change_kind, off_sale_causes, actor_kind, actor_account_id FROM catalog.offer_history
        WHERE market_id = $1 AND offer_id = $2 AND offer_version > 3`,
      [market.marketId, refusedOffer],
    );
    expect(history.rows).toEqual([
      {
        change_kind: 'causes-changed',
        off_sale_causes: ['type-not-allowed'],
        actor_kind: 'admin',
        actor_account_id: admin.actor.kind === 'authenticated' ? admin.actor.accountId : null,
      },
    ]);
    const untouched = await owner.query(
      'SELECT count(*)::int AS n FROM catalog.offer_history WHERE market_id = $1 AND offer_id = $2 AND offer_version > 3',
      [market.marketId, allowedOffer],
    );
    expect(untouched.rows[0]).toEqual({ n: 0 });
    expect(events).toEqual(
      expect.arrayContaining([
        'catalog.product-type-changed.v1',
        'catalog.offer-listing-changed.v1',
      ]),
    );
  });

  it('refuses a count that moved and changes nothing (PLATFORM)', async () => {
    const { id, variantId } = await newProduct('PLATFORM');
    const refusedOffer = await sellingOffer(id, variantId, REFUSED_SELLER);
    const before = await moneyAndStock([refusedOffer]);

    const result = await service.execute(
      actorContext('admin', null),
      input(id, { offOfferCount: 0 }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'confirm.count-changed', currentCount: 1 },
    });
    expect(await productRow(id)).toMatchObject({ type_code: 'simple', variant_model: 'single' });
    expect(await moneyAndStock([refusedOffer])).toEqual(before);
    const offer = await owner.query(
      'SELECT listed, off_sale_type_not_allowed FROM catalog.offers WHERE market_id = $1 AND id = $2',
      [market.marketId, refusedOffer],
    );
    expect(offer.rows[0]).toEqual({ listed: true, off_sale_type_not_allowed: false });
  });
});
