import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductSellUnitFactsReader } from '../../src/modules/catalog/infrastructure/prisma-product-sell-unit-facts.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The product facts behind `own-offer.read-sell-units` on PostgreSQL, for both Market fixtures:
// scope, product code and the number of the non-retired variants, and the Market boundary.

const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog product sell-unit facts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let products: PrismaProductRepository;
  let reader: PrismaProductSellUnitFactsReader;

  beforeAll(() => {
    db = createPersistence();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaProductSellUnitFactsReader(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: false,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  it('reads the scope, the code and the numbered variants, and nothing across Markets', async () => {
    const variantId = uuid7() as Id<'Variant'>;
    const productCode = `F${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode,
      variantId,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const productId = created.value.state.id;
    await run(market, () => products.add(market, created.value));

    const facts = await run(market, () => reader.read(market, productId));
    expect(facts).toEqual({
      scope: 'PLATFORM',
      productCode,
      variants: [{ variantId, variantNo: 1 }],
    });
    expect(await run(other, () => reader.read(other, productId))).toBeNull();
    expect(await run(market, () => reader.read(market, uuid7() as Id<'Product'>))).toBeNull();
  });
});
