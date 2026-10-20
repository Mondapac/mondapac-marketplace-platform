// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { ProductPage } from '../src/product/product-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import {
  isProductId,
  productDetailOf,
  type ProductDetailBody,
} from '../src/storefront/product-detail.ts';

// The product page on the API's answer (`search/product-detail/:id`): what the API has is shown,
// what it does not have yet (delivery window, seller city, photos, specifications, badges,
// similar products) is left out rather than invented.

afterEach(cleanup);

const PRODUCT = '01990000-0000-7000-8000-000000000900';
const labels = {
  minimum: (amount: string) => `${amount} minimum order`,
  noMinimum: 'No minimum order',
};

const unit = (
  amount: string,
  stock: ProductDetailBody['offers'][number]['units'][number]['stock'] = {
    status: 'in-stock',
    onlyLeft: null,
  },
) => ({
  variantId: '01990000-0000-7000-8000-000000002001',
  label: null,
  price: { amount, currency: 'AUD' },
  taxInclusive: true,
  special: null,
  stock,
});

const body = (offers: ProductDetailBody['offers']): ProductDetailBody => ({
  productId: PRODUCT,
  name: 'Lamb shoulder',
  shortDescription: 'Bone in',
  description: 'Lamb shoulder from a Queensland farm.',
  categoryIds: ['01990000-0000-7000-8000-0000000000ca'],
  offers,
});

const TWO_SELLERS = body([
  {
    offerId: '01990000-0000-7000-8000-000000001001',
    sellerId: '01990000-0000-7000-8000-000000005001',
    seller: { storeName: 'Kedron Butchers', minimumOrder: { amount: '3000', currency: 'AUD' } },
    units: [unit('1890', { status: 'low', onlyLeft: 2 })],
  },
  {
    offerId: '01990000-0000-7000-8000-000000001002',
    sellerId: '01990000-0000-7000-8000-000000005002',
    seller: { storeName: 'Logan Road Meats', minimumOrder: null },
    units: [unit('2100')],
  },
]);

describe('product detail mapping', () => {
  it('takes only product ids to the API', () => {
    expect(isProductId(PRODUCT)).toBe(true);
    expect(isProductId('whole-chicken')).toBe(false);
  });

  it('maps offers, stock and minimum orders, and leaves out what the API has not', () => {
    const detail = productDetailOf(TWO_SELLERS, 'en', labels)!;
    expect(detail.offers.map((o) => [o.id, o.seller.name, o.price.amount])).toEqual([
      ['01990000-0000-7000-8000-000000001001', 'Kedron Butchers', 1890],
      ['01990000-0000-7000-8000-000000001002', 'Logan Road Meats', 2100],
    ]);
    expect(detail.offers[0].lowStock).toBe(2);
    expect(detail.offers[0].minimumOrder).toBe('A$30 minimum order');
    expect(detail.offers[0].variantId).toBe('01990000-0000-7000-8000-000000002001');
    expect(detail.offers[1]?.lowStock).toBeUndefined();
    expect(detail.offers[1]?.minimumOrder).toBe('No minimum order');
    expect(detail.offers[0].deliveryWindow).toBeUndefined();
    expect(detail.offers[0].certifications).toEqual([]);
    expect(detail.photos).toEqual([]);
    expect(detail.specifications).toEqual([]);
    expect(detail.similar).toEqual([]);
  });

  it('makes an out-of-stock offer unbuyable and leaves out an unknown minimum', () => {
    const detail = productDetailOf(
      body([
        {
          offerId: '01990000-0000-7000-8000-000000001001',
          sellerId: '01990000-0000-7000-8000-000000005001',
          seller: { storeName: 'Kedron Butchers' },
          units: [unit('1890', { status: 'out', onlyLeft: null })],
        },
      ]),
      'en',
      labels,
    )!;
    expect(detail.offers[0].lowStock).toBe(0);
    expect(detail.offers[0].minimumOrder).toBeUndefined();
  });

  it('is no product when no offer has a seller name or a usable price', () => {
    expect(
      productDetailOf(
        body([
          {
            offerId: '01990000-0000-7000-8000-000000001001',
            sellerId: '01990000-0000-7000-8000-000000005001',
            seller: { storeName: null },
            units: [unit('1890')],
          },
          {
            offerId: '01990000-0000-7000-8000-000000001002',
            sellerId: '01990000-0000-7000-8000-000000005002',
            seller: { storeName: 'Logan Road Meats' },
            units: [unit('12.5')],
          },
        ]),
        'en',
        labels,
      ),
    ).toBeUndefined();
  });
});

describe('product page on API data', () => {
  it('shows the price, stock and minimum order, without delivery, city or photos', () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('min-width: 1000px'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <ProductPage product={productDetailOf(TWO_SELLERS, 'en', labels)!} category={undefined} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    const box = screen.getByRole('complementary', { name: 'Buy options' });
    expect(within(box).getByText('A$18.90')).toBeTruthy();
    expect(within(box).getByText('Only 2 left')).toBeTruthy();
    expect(within(box).getAllByText('A$30 minimum order').length).toBeGreaterThan(0);
    expect(within(box).queryByText(/delivery/i)).toBeNull();
    expect(screen.queryByText(/selling since/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Similar products' })).toBeNull();
    const others = screen.getByRole('region', { name: 'Other sellers' });
    expect(within(others).getAllByText('No minimum order').length).toBeGreaterThan(0);
  });

  it('leaves out an empty Details section', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <ProductPage
            product={productDetailOf(
              { ...TWO_SELLERS, description: null, shortDescription: null },
              'en',
              labels,
            )!}
            category={undefined}
          />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('heading', { name: 'Details' })).toBeNull();
  });
});
