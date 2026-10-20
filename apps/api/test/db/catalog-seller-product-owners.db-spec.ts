import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaSellerProductOwnersReader } from '../../src/modules/catalog/infrastructure/prisma-seller-product-owners.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// `sellerProductOwners` reader on PostgreSQL, for both Market fixtures: the owning seller of a
// SELLER product; a PLATFORM product, an unknown id and another Market's product are absent.

const T0 = Temporal.Instant.from('2026-10-19T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog seller product owners in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let products: PrismaProductRepository;
  let reader: PrismaSellerProductOwnersReader;

  beforeAll(() => {
    db = createPersistence();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaSellerProductOwnersReader(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>, readOnly = false) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), { readOnly });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  async function product(
    target: typeof market,
    sellerId: Id<'Seller'> | null,
  ): Promise<Id<'Product'>> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: sellerId === null ? 'PLATFORM' : 'SELLER',
      sellerId,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `O${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await run(target, () => products.add(target, created.value));
    return created.value.state.id;
  }

  it("answers a SELLER product's owner and leaves the rest out", async () => {
    const sellerId = uuid7() as Id<'Seller'>;
    const own = await product(market, sellerId);
    const platform = await product(market, null);
    const elsewhere = await product(other, uuid7() as Id<'Seller'>);
    const unknown = uuid7() as Id<'Product'>;

    const owners = await run(
      market,
      () => reader.read(market, [own, platform, elsewhere, unknown]),
      true,
    );
    expect([...owners]).toEqual([[own, sellerId]]);
    expect(await run(market, () => reader.read(market, []), true)).toEqual(new Map());
  });
});
