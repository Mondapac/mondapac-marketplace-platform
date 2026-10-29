// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { SellerPage } from '../src/seller/seller-page.tsx';
import { StoreCard } from '../src/sellers/store-card.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import {
  listingOf,
  publicStoreOf,
  publicStorePageOf,
  sellerResultsOf,
  shopOf,
  StoreAnswerRefused,
} from '../src/storefront/real-sellers.ts';

// The storefront's wiring to the API's public store reads: the strict reading of the answer and
// the seller pages with real data, where every part the API does not know yet is left out. The
// request itself (host to Market, signed client address) is storefront-api.spec.ts's.

afterEach(cleanup);

const STORE = {
  slug: 'kedron-halal',
  name: 'Kedron Halal Meats',
  serviceAreaCode: 'greater-brisbane',
  sellingSince: 2026,
  minimumOrder: { amount: '3000', currency: 'AUD' },
};

describe('reading the API store answer', () => {
  it('reads a store, with Money as a number of minor units', () => {
    expect(publicStoreOf(STORE)).toEqual({
      ...STORE,
      minimumOrder: { amount: 3000, currency: 'AUD' },
    });
    expect(publicStoreOf({ ...STORE, minimumOrder: null }).minimumOrder).toBeNull();
    expect('minimumOrder' in publicStoreOf({ ...STORE, minimumOrder: undefined })).toBe(false);
  });

  it.each([
    ['a missing body', undefined],
    ['a bad slug', { ...STORE, slug: '../x' }],
    ['an empty name', { ...STORE, name: ' ' }],
    ['a bad area', { ...STORE, serviceAreaCode: 'Greater Brisbane' }],
    ['a bad year', { ...STORE, sellingSince: '2026' }],
    ['a year in the future', { ...STORE, sellingSince: new Date().getUTCFullYear() + 2 }],
    ['a numeric amount', { ...STORE, minimumOrder: { amount: 3000, currency: 'AUD' } }],
    ['a bad currency', { ...STORE, minimumOrder: { amount: '1', currency: 'aud' } }],
  ])('refuses %s whole', (_name, body) => {
    expect(() => publicStoreOf(body)).toThrow(StoreAnswerRefused);
  });

  it('reads a page and refuses one without a total', () => {
    expect(publicStorePageOf({ items: [STORE], total: 1 }).total).toBe(1);
    expect(() => publicStorePageOf({ items: [STORE] })).toThrow(StoreAnswerRefused);
  });

  it('offers no filter it cannot answer, and an unknown location', () => {
    const results = sellerResultsOf([publicStoreOf(STORE)], 7, () => 'Greater Brisbane');
    expect(results.total).toBe(7);
    expect(results.location).toBe('unknown');
    expect(results.facets.certifications).toEqual([]);
    expect(results.items[0]?.city).toBe('Greater Brisbane');
  });
});

describe('seller pages with real data', () => {
  const wrap = (node: React.ReactNode) =>
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>{node}</StoreProvider>
      </NextIntlClientProvider>,
    );

  it('shows the store page without the parts the API does not know yet', () => {
    wrap(
      <SellerPage shop={shopOf(publicStoreOf(STORE), 'Greater Brisbane')} ratingsShown={false} />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Kedron Halal Meats');
    // One part known: a heading, not a tab bar with a single tab.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'About' })).toBeTruthy();
    expect(document.body.textContent).toContain('Greater Brisbane');
    expect(document.body.textContent).toContain('$30.00');
    expect(document.body.textContent).not.toMatch(/no certificates|no products/i);
    expect(document.querySelector('.shop-text')).toBeNull();
  });

  it('shows a store card without delivery terms or a product count', () => {
    wrap(
      <StoreCard
        store={listingOf(publicStoreOf({ ...STORE, minimumOrder: undefined }), 'Greater Brisbane')}
        location="unknown"
        ratingsShown={false}
      />,
    );
    expect(screen.getByRole('link').textContent).toBe('Kedron Halal Meats');
    expect(document.querySelectorAll('.slc-d li')).toHaveLength(0);
    expect(document.querySelector('.slc-p .n')).toBeNull();
  });
});
