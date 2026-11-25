import { offerViewOf } from './own-offer-view';

// The product part of a seller's Offer view (Offer page PR 3b): scope and thumbnail.

const offer = {
  state: {
    id: 'o1',
    productId: 'p1',
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: {},
    status: 'draft',
    listed: false,
    offSaleCauses: [],
    handling: null,
    attestationRecordedAt: null,
    submittedAt: null,
    firstPublishedAt: null,
    createdAt: { toString: () => '2026-11-25T00:00:00Z' },
    version: 1,
  },
  tags: [],
} as unknown as Parameters<typeof offerViewOf>[0];

describe('offerViewOf product', () => {
  it('gives no scope and no thumbnail when the product label was not found', () => {
    expect(offerViewOf(offer, undefined).product).toEqual({
      productCode: null,
      typeCode: null,
      name: null,
      scope: null,
      primaryImageId: null,
    });
  });

  it('carries the label scope and thumbnail', () => {
    expect(
      offerViewOf(offer, {
        productId: 'p1' as never,
        productCode: 'P1',
        typeCode: 'simple',
        scope: 'SELLER',
        name: 'Spice mix',
        primaryImageId: 'img-1' as never,
      }).product,
    ).toEqual({
      productCode: 'P1',
      typeCode: 'simple',
      name: 'Spice mix',
      scope: 'SELLER',
      primaryImageId: 'img-1',
    });
  });
});
