import { describe, expect, it } from 'vitest';
import { productThumbSrc } from './product-thumb.ts';

const PRODUCT = '0190a000-0000-7000-8000-0000000000b1';
const IMAGE = '0190a000-0000-7000-8000-0000000000d1';

describe('productThumbSrc', () => {
  it('serves a platform photo from the public route of the Market and a seller photo from the own route', () => {
    expect(
      productThumbSrc('AU', { productId: PRODUCT, scope: 'PLATFORM', primaryImageId: IMAGE }),
    ).toBe(`/api/catalog/public-images/AU/${PRODUCT}/${IMAGE}/thumb`);
    expect(
      productThumbSrc('NZ', { productId: PRODUCT, scope: 'PLATFORM', primaryImageId: IMAGE }),
    ).toBe(`/api/catalog/public-images/NZ/${PRODUCT}/${IMAGE}/thumb`);
    expect(
      productThumbSrc('AU', { productId: PRODUCT, scope: 'SELLER', primaryImageId: IMAGE }),
    ).toBe(`/api/catalog/seller/products/${PRODUCT}/images/${IMAGE}/thumb`);
  });

  it('gives no address without a photo or with an unknown scope', () => {
    expect(
      productThumbSrc('AU', { productId: PRODUCT, scope: 'PLATFORM', primaryImageId: null }),
    ).toBeNull();
    expect(
      productThumbSrc('AU', { productId: PRODUCT, scope: null, primaryImageId: IMAGE }),
    ).toBeNull();
  });

  it('gives no address for an id that is not a UUID', () => {
    expect(
      productThumbSrc('AU', { productId: '../..', scope: 'PLATFORM', primaryImageId: IMAGE }),
    ).toBeNull();
    expect(
      productThumbSrc('AU', { productId: PRODUCT, scope: 'SELLER', primaryImageId: 'x/../y' }),
    ).toBeNull();
  });
});
