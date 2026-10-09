import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator } from '@mondapac/shared-kernel';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
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

  it('answers the one-Offer-per-product-and-seller unique as a refusal', async () => {
    const product = await newProduct();
    const seller = uuid7() as Id<'Seller'>;
    await run(market, () => offers.add(market, newOffer(product, seller, 'SKU-A'), actor));
    const second = newOffer(product, seller, 'SKU-B');
    const refusal = await persistence.unitOfWork.run(market, async () => ({
      ok: true as const,
      value: await offers.add(market, second, actor),
    }));
    expect(refusal).toEqual({ ok: true, value: 'offer.exists-for-product' });
  });

  it('answers the SKU unique as a refusal, per seller only', async () => {
    const seller = uuid7() as Id<'Seller'>;
    const [first, second, third] = [await newProduct(), await newProduct(), await newProduct()];
    await run(market, () => offers.add(market, newOffer(first, seller, 'SKU-SAME'), actor));
    const clash = await persistence.unitOfWork.run(market, async () => ({
      ok: true as const,
      value: await offers.add(market, newOffer(second, seller, 'SKU-SAME'), actor),
    }));
    expect(clash).toEqual({ ok: true, value: 'offer.sku-taken' });
    const otherSeller = uuid7() as Id<'Seller'>;
    expect(
      await run(market, () => offers.add(market, newOffer(third, otherSeller, 'SKU-SAME'), actor)),
    ).toBeNull();
  });

  describe('offerSellUnits reader', () => {
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
