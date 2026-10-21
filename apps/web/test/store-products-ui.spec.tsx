// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { CardPhoto } from '../src/home/card-photo.tsx';
import { Gallery } from '../src/product/gallery.tsx';
import { SellerPage } from '../src/seller/seller-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { storePageOf, storeProductsOf } from '../src/storefront/store-products.ts';
import { photoUrlBuilder } from '../src/storefront/photos.ts';
import type { SellerShop, StoreProducts } from '../src/storefront/types.ts';

// The seller page's Products tab on the API's page of cards, and the photo fallbacks.

afterEach(cleanup);

const PRODUCT = '01990000-0000-7000-8000-000000000900';
const IMAGE = '01990000-0000-7000-8000-0000000000a1';
const photo = photoUrlBuilder('https://img.example.com', 'AU')!;

const SHOP: SellerShop = {
  id: 'kedron-halal',
  name: 'Kedron Halal Meats',
  location: 'Greater Brisbane',
  sellingSince: 2026,
};

const card = (id: string, name: string, imageUrl?: string) => ({
  id,
  name,
  sellerName: '',
  category: 'meat',
  certifications: [],
  ...(imageUrl === undefined ? {} : { imageUrl }),
});

function show(products: StoreProducts) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <SellerPage shop={{ ...SHOP, storeProducts: products }} ratingsShown={false} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('Products tab of a real store', () => {
  it('shows the cards with their photos and a Products tab without a count', () => {
    show({
      kind: 'ok',
      page: 1,
      hasMore: false,
      items: [
        card(PRODUCT, 'Lamb shoulder', photo(PRODUCT, IMAGE, 'medium')),
        card('p2', 'Beef mince'),
      ],
    });
    expect(screen.getByRole('tab', { name: 'Products' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Lamb shoulder' });
    expect(link.getAttribute('href')).toBe(`/p/${PRODUCT}`);
    const img = document.querySelector('img.photo');
    expect(img?.getAttribute('src')).toBe(
      `https://img.example.com/catalog/public-images/AU/${PRODUCT}/${IMAGE}/medium`,
    );
    expect(screen.getByRole('link', { name: 'Beef mince' })).toBeTruthy();
    // Search, sort and chips would act on one page only, so they are not offered.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Products pages' })).toBeNull();
  });

  it('pages with links that carry the page number', () => {
    show({ kind: 'ok', page: 2, hasMore: true, items: [card('p3', 'Chicken thigh')] });
    const nav = screen.getByRole('navigation', { name: 'Products pages' });
    expect(within(nav).getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe(
      '/s/kedron-halal',
    );
    expect(within(nav).getByRole('link', { name: 'Next' }).getAttribute('href')).toBe(
      '/s/kedron-halal?page=3',
    );
    expect(within(nav).getByText('Page 2')).toBeTruthy();
  });

  it('says so for a store with no products and for a page past the end', () => {
    show({ kind: 'ok', page: 1, hasMore: false, items: [] });
    expect(screen.getByText('No products yet')).toBeTruthy();
    cleanup();
    show({ kind: 'ok', page: 9, hasMore: false, items: [] });
    expect(screen.getByRole('link', { name: 'Back to the first page' })).toBeTruthy();
  });

  it('says the products could not be loaded, inside the tab, and keeps the other tabs', () => {
    show({ kind: 'failed' });
    expect(screen.getByRole('alert').textContent).toContain('Products could not be loaded');
    expect(screen.getByRole('tab', { name: 'About' })).toBeTruthy();
  });
});

describe('reading the products page', () => {
  const item = { offerId: 'o', productId: PRODUCT, sellerId: 's', name: 'Lamb', categoryIds: [] };

  it('refuses a body that is not a page, whole', () => {
    for (const body of [null, 'x', [], {}, { items: {} }, { items: [item] }, { hasMore: true }]) {
      expect(storeProductsOf(body, 1, new Map(), photo)).toEqual({ kind: 'failed' });
    }
  });

  it('keeps the good items of a page and drops the bad ones', () => {
    const read = storeProductsOf(
      { items: [item, { nonsense: true }, null], hasMore: false },
      1,
      new Map(),
      photo,
    );
    expect(read).toMatchObject({ kind: 'ok', hasMore: false });
    expect(read.kind === 'ok' && read.items.map((c) => c.name)).toEqual(['Lamb']);
  });

  it('takes the page of the URL only as a whole number from 1 to 100', () => {
    expect(storePageOf('3')).toBe(3);
    expect(storePageOf('100')).toBe(100);
    for (const value of [undefined, '0', '101', '-1', '2.5', 'x', '1e3', ['2', '3'], '0003x']) {
      expect(storePageOf(value)).toBe(1);
    }
  });
});

describe('photos that fail to load', () => {
  it('a card shows its illustration instead of a broken image', () => {
    const { container } = render(<CardPhoto src="https://img.example.com/x" category="meat" />);
    const img = container.querySelector('img')!;
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('the gallery drops a photo that fails and shows the art when none is left', () => {
    const urls = ['https://img.example.com/a', 'https://img.example.com/b'];
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Gallery
          name="Lamb shoulder"
          category="meat"
          photos={urls}
          thumbs={['https://img.example.com/a-t', 'https://img.example.com/b-t']}
          certifications={[]}
          special={false}
        />
      </NextIntlClientProvider>,
    );
    expect(container.querySelectorAll('.gth button')).toHaveLength(2);
    expect(container.querySelector('.gth img')?.getAttribute('src')).toBe(
      'https://img.example.com/a-t',
    );
    fireEvent.error(container.querySelector('.gmain img')!);
    expect(container.querySelector('.gmain img')?.getAttribute('src')).toBe(urls[1]);
    expect(container.querySelector('.gth')).toBeNull();
    fireEvent.error(container.querySelector('.gmain img')!);
    expect(container.querySelector('.gmain img')).toBeNull();
    expect(container.querySelector('.gmain.nophoto')).not.toBeNull();
  });
});
