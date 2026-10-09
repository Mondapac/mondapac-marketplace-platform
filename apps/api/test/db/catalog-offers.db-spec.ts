import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator } from '@mondapac/shared-kernel';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaOfferSellUnitsReader } from '../../src/modules/catalog/infrastructure/prisma-offer-sell-units.reader';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';
import { Client } from 'pg';

// Catalog slice 7 part 1 on PostgreSQL, for both Market fixtures: the Offer repository (round trip,
// the two partial uniques answered as refusals, first history row, Market independence) and the
// offerSellUnits reader (query A1).

const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)('catalog offers in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let offers: PrismaOfferRepository;
  let products: PrismaProductRepository;
  let reader: PrismaOfferSellUnitsReader;
  let owner: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    offers = new PrismaOfferRepository(persistence.service, ids);
    products = new PrismaProductRepository(persistence.service);
    reader = new PrismaOfferSellUnitsReader(persistence.service);
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await persistence.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>): Promise<T> => {
    const result = await persistence.unitOfWork.run(target, async () => ({
      ok: true as const,
      value: await work(),
    }));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  async function newProduct(target = market): Promise<Product> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `O${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await run(target, () => products.add(target, created.value));
    return created.value;
  }

  function newOffer(
    product: Product,
    sellerId: Id<'Seller'>,
    sellerSku: string,
    target = market,
  ): Offer {
    const created = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: target.marketId,
      sellerId,
      productId: product.state.id,
      sellerSku,
      conditionCode: 'new',
      description: { en: 'Fresh' },
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  }

  const actor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };

  it('stores an Offer, reads it back, and writes the first history row', async () => {
    const product = await newProduct();
    const seller = uuid7() as Id<'Seller'>;
    const offer = newOffer(product, seller, 'SKU-1');
    expect(await run(market, () => offers.add(market, offer, actor))).toBeNull();
    const found = await run(market, () => offers.findById(market, offer.state.id));
    expect(found?.state).toEqual(offer.state);
    expect(found?.persistedVersion).toBe(1);
    const history = await owner.query(
      `SELECT change_kind, offer_version, actor_kind, actor_account_id, status
         FROM catalog.offer_history WHERE market_id = $1 AND offer_id = $2`,
      [market.marketId, offer.state.id],
    );
    expect(history.rows).toEqual([
      {
        change_kind: 'created',
        offer_version: 1,
        actor_kind: 'seller',
        actor_account_id: actor.accountId,
        status: 'draft',
      },
    ]);
  });

  it('does not find an Offer through another Market', async () => {
    const product = await newProduct();
    const offer = newOffer(product, uuid7() as Id<'Seller'>, 'SKU-2');
    await run(market, () => offers.add(market, offer, actor));
    expect(await run(other, () => offers.findById(other, offer.state.id))).toBeNull();
  });

  /** A unit that ends with the refusal as an error, as the port's contract requires. */
  const addInUnit = (offer: Offer) =>
    persistence.unitOfWork.run(market, async () => {
      const refusal = await offers.add(market, offer, actor);
      return refusal === null
        ? { ok: true as const, value: null }
        : { ok: false as const, error: refusal };
    });

  it('answers the one-Offer-per-product-and-seller unique as a refusal', async () => {
    const product = await newProduct();
    const seller = uuid7() as Id<'Seller'>;
    await run(market, () => offers.add(market, newOffer(product, seller, 'SKU-A'), actor));
    const second = newOffer(product, seller, 'SKU-B');
    expect(await addInUnit(second)).toEqual({ ok: false, error: 'offer.exists-for-product' });
  });

  it('answers the SKU unique as a refusal, per seller only', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const [first, second, third] = [await newProduct(), await newProduct(), await newProduct()];
    await run(market, () => offers.add(market, newOffer(first, seller, 'SKU-SAME'), actor));
    expect(await addInUnit(newOffer(second, seller, 'SKU-SAME'))).toEqual({
      ok: false,
      error: 'offer.sku-taken',
    });
    const otherSeller = uuid7() as Id<'Seller'>;
    expect(
      await run(market, () => offers.add(market, newOffer(third, otherSeller, 'SKU-SAME'), actor)),
    ).toBeNull();
  });

  it('reads back every stored field and all five off-sale causes', async () => {
    const product = await newProduct();
    const id = uuid7();
    const seller = uuid7();
    const account = uuid7();
    await owner.query(
      `INSERT INTO catalog.offers (id, market_id, tenant_id, seller_id, product_id, seller_sku,
         condition_code, description, handling, attestation_recorded_at, attestation_account_id,
         status, off_sale_type_not_allowed, off_sale_product_retired, off_sale_product_not_listed,
         off_sale_tag_suspended, off_sale_description_claim_text, listed, submitted_at,
         first_published_at, version, created_at)
       VALUES ($1,$2,$3,$4,$5,'SKU-FULL','used','{"en":"x"}','SEALED_ORIGINAL',$6,$7,'published',
         false,true,false,true,false,false,$6,$6,3,$6)`,
      [id, market.marketId, market.tenantId, seller, product.state.id, T0.toString(), account],
    );
    const found = await run(market, () => offers.findById(market, id as Id<'Offer'>));
    expect(found?.state).toMatchObject({
      status: 'published',
      handling: 'SEALED_ORIGINAL',
      conditionCode: 'used',
      listed: false,
      offSaleCauses: ['product-retired', 'tag-suspended'],
      attestationAccountId: account,
      version: 3,
    });
    expect(found?.state.attestationRecordedAt?.toString()).toBe(T0.toString());
    expect(found?.state.submittedAt?.toString()).toBe(T0.toString());
    expect(found?.state.firstPublishedAt?.toString()).toBe(T0.toString());
    expect(found?.persistedVersion).toBe(3);
  });

  it('leaves no Offer and no history row behind when the unit ends with an error', async () => {
    const product = await newProduct();
    const seller = uuid7() as Id<'Seller'>;
    await run(market, () => offers.add(market, newOffer(product, seller, 'SKU-KEEP'), actor));
    const refused = newOffer(product, seller, 'SKU-OTHER');
    const outcome = await persistence.unitOfWork.run(market, async () => {
      const refusal = await offers.add(market, refused, actor);
      return refusal === null
        ? { ok: true as const, value: null }
        : { ok: false as const, error: refusal };
    });
    expect(outcome).toEqual({ ok: false, error: 'offer.exists-for-product' });
    const rows = await owner.query(
      `SELECT (SELECT count(*) FROM catalog.offers WHERE id = $1) AS offers,
              (SELECT count(*) FROM catalog.offer_history WHERE offer_id = $1) AS history`,
      [refused.state.id],
    );
    expect(rows.rows[0]).toEqual({ offers: '0', history: '0' });
  });

  it('lets exactly one of two concurrent creations win', async () => {
    const product = await newProduct();
    const seller = uuid7() as Id<'Seller'>;
    const attempt = (sku: string) =>
      persistence.unitOfWork.run(market, async () => {
        const refusal = await offers.add(market, newOffer(product, seller, sku), actor);
        return refusal === null
          ? { ok: true as const, value: null }
          : { ok: false as const, error: refusal };
      });
    const results = await Promise.all([attempt('SKU-RACE-1'), attempt('SKU-RACE-2')]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'offer.exists-for-product' },
    ]);
  });

  it.each(['admin', 'system'] as const)('records a %s actor in the history row', async (kind) => {
    const product = await newProduct();
    const offer = newOffer(product, uuid7() as Id<'Seller'>, `SKU-${kind}`);
    const accountId = kind === 'system' ? null : (uuid7() as Id<'Account'>);
    await run(market, () => offers.add(market, offer, { kind, accountId }));
    const history = await owner.query(
      'SELECT actor_kind, actor_account_id FROM catalog.offer_history WHERE offer_id = $1',
      [offer.state.id],
    );
    expect(history.rows).toEqual([{ actor_kind: kind, actor_account_id: accountId }]);
  });

  describe('offerSellUnits reader', () => {
    it('includes proposed and published variants, excludes retired ones, in creation order', async () => {
      const configurable = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: configurableProductType,
        familyCode: 'default',
        productCode: `V${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
        variantId: null,
        now: T0,
      });
      if (!configurable.ok) throw new Error(configurable.error.code);
      const product = configurable.value;
      await run(market, () => products.add(market, product));
      const variants = [
        { id: uuid7(), state: 'proposed', at: '2026-10-09T00:00:01Z' },
        { id: uuid7(), state: 'published', at: '2026-10-09T00:00:02Z' },
        { id: uuid7(), state: 'retired', at: '2026-10-09T00:00:03Z' },
      ];
      for (const variant of variants) {
        await owner.query(
          `INSERT INTO catalog.product_variants (id, market_id, tenant_id, product_id,
             variant_model, state, created_at, published_at, retired_at)
           VALUES ($1,$2,$3,$4,'options','proposed',$5,NULL,NULL)`,
          [variant.id, market.marketId, market.tenantId, product.state.id, variant.at],
        );
      }
      await owner.query(
        `UPDATE catalog.product_variants SET state='published', published_at=now()
           WHERE market_id=$1 AND id=$2`,
        [market.marketId, variants[1]!.id],
      );
      await owner.query(
        `UPDATE catalog.product_variants SET state='retired', retired_at=now()
           WHERE market_id=$1 AND id=$2`,
        [market.marketId, variants[2]!.id],
      );
      const offer = newOffer(product, uuid7() as Id<'Seller'>, 'SKU-VARS');
      await run(market, () => offers.add(market, offer, actor));
      const map = await run(market, () => reader.read(market, [offer.state.id]));
      expect(map.get(offer.state.id)?.sellUnits).toEqual([
        { variantId: variants[0]!.id, state: 'proposed' },
        { variantId: variants[1]!.id, state: 'published' },
      ]);
    });

    it('returns the Offer with its non-retired variants, and omits unknown and other-Market ids', async () => {
      const product = await newProduct();
      const offer = newOffer(product, uuid7() as Id<'Seller'>, 'SKU-R1');
      await run(market, () => offers.add(market, offer, actor));
      const foreignProduct = await newProduct(other);
      const foreign = newOffer(foreignProduct, uuid7() as Id<'Seller'>, 'SKU-R2', other);
      await run(other, () => offers.add(other, foreign, actor));
      const unknown = uuid7() as Id<'Offer'>;

      const map = await run(market, () =>
        reader.read(market, [offer.state.id, foreign.state.id, unknown]),
      );
      expect([...map.keys()]).toEqual([offer.state.id]);
      expect(map.get(offer.state.id)).toEqual({
        sellerId: offer.state.sellerId,
        productId: product.state.id,
        status: 'draft',
        listed: false,
        sellUnits: product.state.variants.map((variant) => ({
          variantId: variant.id,
          state: variant.state,
        })),
      });
    });

    it('presents a deleted Offer with no sell units', async () => {
      const product = await newProduct();
      const offer = newOffer(product, uuid7() as Id<'Seller'>, 'SKU-R3');
      await run(market, () => offers.add(market, offer, actor));
      await owner.query(
        `UPDATE catalog.offers SET status = 'deleted', deleted_at = now(), version = 2
           WHERE market_id = $1 AND id = $2`,
        [market.marketId, offer.state.id],
      );
      const map = await run(market, () => reader.read(market, [offer.state.id]));
      expect(map.get(offer.state.id)).toMatchObject({ status: 'deleted', sellUnits: [] });
    });

    it('answers an empty request with an empty map', async () => {
      expect((await run(market, () => reader.read(market, []))).size).toBe(0);
    });
  });
});
