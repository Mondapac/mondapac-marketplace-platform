import { err, ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SellersFacade } from '../../sellers';
import { SellersAllowedProductTypesReader } from './sellers-allowed-product-types.reader';

// The binding of SEL-12 to sellers.allowedProductTypesOf: an answer passes through, and any
// refusal or thrown error is null, which every caller refuses (fail closed, ADR-0031).

const SELLER = '01990000-0000-7000-8000-00000000b020' as Id<'Seller'>;

describe.each(['AU', 'ZZ'])('SellersAllowedProductTypesReader, Market %s', (code) => {
  const context = () => testCallContext(testMarketContext(code, 'default'), 'anonymous');
  const readerAnswering = (answer: () => ReturnType<SellersFacade['allowedProductTypesOf']>) =>
    new SellersAllowedProductTypesReader({
      allowedProductTypesOf: answer,
    } as unknown as SellersFacade);

  it('passes all and a set of codes through', async () => {
    expect(
      await readerAnswering(() => Promise.resolve(ok('all'))).allowedFor(context(), SELLER),
    ).toBe('all');
    const codes = new Set(['grocery']);
    expect(
      await readerAnswering(() => Promise.resolve(ok(codes))).allowedFor(context(), SELLER),
    ).toBe(codes);
  });

  it('answers null on a refusal and on a thrown error, never allowed', async () => {
    expect(
      await readerAnswering(() =>
        Promise.resolve(err({ code: 'sellers.unavailable' as const })),
      ).allowedFor(context(), SELLER),
    ).toBeNull();
    expect(
      await readerAnswering(() => Promise.reject(new Error('down'))).allowedFor(context(), SELLER),
    ).toBeNull();
  });
});
