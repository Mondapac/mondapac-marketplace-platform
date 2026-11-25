import { platformSearchQuery } from './own-product.controller';

// The address of `GET catalog/seller/products/platform-search` as the use case takes it.

describe('platformSearchQuery', () => {
  it('turns notSelling=true and false into booleans', () => {
    expect(platformSearchQuery({ q: 'beef', notSelling: 'true' })).toEqual({
      q: 'beef',
      notSelling: true,
    });
    expect(platformSearchQuery({ notSelling: 'false' })).toEqual({ notSelling: false });
  });

  it('leaves any other notSelling text for the use case to refuse', () => {
    expect(platformSearchQuery({ notSelling: 'yes' })).toEqual({ notSelling: 'yes' });
  });

  it('reads the page as a number and the barcodes as a list', () => {
    expect(platformSearchQuery({ page: '2', barcodes: '4006381333931, 96385074' })).toEqual({
      page: 2,
      barcodes: ['4006381333931', '96385074'],
    });
  });
});
