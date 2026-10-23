import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CatalogFacade } from '../../catalog';
import type { SellersFacade } from '../../sellers';
import { FacadeProductImages } from './facade-product-images';
import { FacadeStoreResolver } from './facade-store-resolver';

// The two facade adapters of the storefront products package, on both Market fixtures: each calls
// the other module with the request's context unchanged and turns any refusal or failure into
// `null`, so the caller decides (no photo, or fail closed).

const product = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Product'>;
const seller = '01990000-0000-7000-8000-0000000000a1' as Id<'Seller'>;
const photo = '01990000-0000-7000-8000-000000000701' as Id<'ProductImage'>;

describe.each(['AU', 'ZZ'])('search facade adapters in market %s', (code) => {
  const context: CallContext = testCallContext(testMarketContext(code, 'default'), 'anonymous');

  describe('FacadeProductImages', () => {
    const catalogWith = (
      answer: () => Promise<unknown>,
      calls: { context: CallContext; ids: readonly Id<'Product'>[] }[] = [],
    ) =>
      ({
        publishedProductImages: (ctx: CallContext, ids: readonly Id<'Product'>[]) => {
          calls.push({ context: ctx, ids });
          return answer();
        },
      }) as unknown as CatalogFacade;

    it("asks catalog with the request's context unchanged and passes the answer through", async () => {
      const calls: { context: CallContext; ids: readonly Id<'Product'>[] }[] = [];
      const answer = new Map([[product(1), [{ imageId: photo, width: 10, height: 20 }]]]);
      const images = new FacadeProductImages(catalogWith(() => Promise.resolve(ok(answer)), calls));

      expect(await images.of(context, [product(1), product(2)])).toBe(answer);
      expect(calls).toEqual([{ context, ids: [product(1), product(2)] }]);
    });

    it('asks nothing for no products', async () => {
      const calls: { context: CallContext; ids: readonly Id<'Product'>[] }[] = [];
      const images = new FacadeProductImages(
        catalogWith(() => Promise.resolve(ok(new Map())), calls),
      );

      expect(await images.of(context, [])).toEqual(new Map());
      expect(calls).toEqual([]);
    });

    it.each([
      ['a refusal', () => Promise.resolve(err({ code: 'batch.too-large' }))],
      ['a thrown error', () => Promise.reject(new Error('down'))],
    ])('is null for %s', async (_name, answer) => {
      expect(
        await new FacadeProductImages(catalogWith(answer)).of(context, [product(1)]),
      ).toBeNull();
    });
  });

  describe('FacadeStoreResolver', () => {
    const sellersWith = (answer: () => Promise<unknown>, asked: string[] = []) =>
      ({
        publishedStoreSellerId: (_ctx: CallContext, slug: string) => {
          asked.push(slug);
          return answer();
        },
      }) as unknown as SellersFacade;

    it('gives the seller, or null seller for no such store, through the facade', async () => {
      const asked: string[] = [];
      expect(
        await new FacadeStoreResolver(
          sellersWith(() => Promise.resolve(ok(seller)), asked),
        ).sellerIdOf(context, 'halal-shop'),
      ).toEqual({ sellerId: seller });
      expect(
        await new FacadeStoreResolver(
          sellersWith(() => Promise.resolve(ok(null)), asked),
        ).sellerIdOf(context, 'no-shop'),
      ).toEqual({ sellerId: null });
      expect(asked).toEqual(['halal-shop', 'no-shop']);
    });

    it.each([
      ['a refusal', () => Promise.resolve(err({ code: 'sellers.unavailable' }))],
      ['a thrown error', () => Promise.reject(new Error('down'))],
    ])('is null (fail closed) for %s', async (_name, answer) => {
      expect(
        await new FacadeStoreResolver(sellersWith(answer)).sellerIdOf(context, 'halal-shop'),
      ).toBeNull();
    });
  });
});
