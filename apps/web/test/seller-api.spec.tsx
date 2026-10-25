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
  flatFeeOf,
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

  describe('delivery terms', () => {
    const TERMS = { day: 'same-day', from: '09:00', to: '12:30', cutoff: '08:30' };

    it('reads the terms when the store has them, and has none otherwise', () => {
      expect(publicStoreOf({ ...STORE, delivery: TERMS }).delivery).toEqual(TERMS);
      expect(
        publicStoreOf({ ...STORE, delivery: { ...TERMS, to: '24:00', day: 'next-day' } }).delivery,
      ).toMatchObject({ to: '24:00' });
      expect('delivery' in publicStoreOf(STORE)).toBe(false);
    });

    it.each([
      ['null', null],
      ['a string', 'next-day'],
      ['an unknown day', { ...TERMS, day: 'daily' }],
      ['a time that is not a half hour', { ...TERMS, from: '09:15' }],
      ['a time with a zone', { ...TERMS, from: '09:00Z' }],
      ['a numeric time', { ...TERMS, cutoff: 830 }],
      ['a missing time', { ...TERMS, to: undefined }],
      ['a window that closes when it opens', { ...TERMS, from: '12:30' }],
      ['a window that closes before it opens', { ...TERMS, from: '13:00' }],
      ['a window that opens at the end of the day', { ...TERMS, from: '24:00' }],
      ['a cut-off at the end of the day', { ...TERMS, cutoff: '24:00' }],
    ])('refuses %s whole', (_name, delivery) => {
      expect(() => publicStoreOf({ ...STORE, delivery })).toThrow(StoreAnswerRefused);
    });

    it('puts the terms on the store page and not on a card', () => {
      const store = publicStoreOf({ ...STORE, delivery: TERMS });
      expect(shopOf(store, 'Greater Brisbane').delivery).toEqual(TERMS);
      expect('delivery' in listingOf(store, 'Greater Brisbane')).toBe(false);
    });
  });

  describe('flat fee', () => {
    it('reads money as minor units', () => {
      expect(flatFeeOf({ amount: '995', currency: 'AUD' })).toEqual({
        amount: 995,
        currency: 'AUD',
      });
      expect(flatFeeOf({ amount: '0', currency: 'AUD' })).toEqual({ amount: 0, currency: 'AUD' });
    });

    it.each([
      ['no body', undefined],
      ['a numeric amount', { amount: 995, currency: 'AUD' }],
      ['a negative amount', { amount: '-5', currency: 'AUD' }],
      ['a decimal amount', { amount: '9.95', currency: 'AUD' }],
      ['a bad currency', { amount: '995', currency: 'aud' }],
    ])('refuses %s', (_name, body) => {
      expect(() => flatFeeOf(body)).toThrow(StoreAnswerRefused);
    });
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

  describe('delivery line on the store page', () => {
    const shopWith = (
      delivery: object | undefined,
      fee?: { amount: number; currency: string },
    ) => ({
      ...shopOf(publicStoreOf({ ...STORE, ...(delivery ? { delivery } : {}) }), 'Greater Brisbane'),
      ...(fee ? { deliveryFee: fee } : {}),
    });
    const chips = () =>
      Array.from(document.querySelectorAll('.shop-chips li')).map((li) => li.textContent);

    it('words next-day terms with the seller’s clock, in the locale', () => {
      wrap(
        <SellerPage
          shop={shopWith({ day: 'next-day', from: '08:00', to: '12:00', cutoff: '14:00' })}
          ratingsShown={false}
        />,
      );
      expect(chips()).toContain('Order by 2 PM for delivery tomorrow, 8 AM–12 PM');
    });

    it('words same-day terms, minutes, and the end of the day', () => {
      wrap(
        <SellerPage
          shop={shopWith({ day: 'same-day', from: '09:30', to: '24:00', cutoff: '08:30' })}
          ratingsShown={false}
        />,
      );
      expect(chips()).toContain('Order by 8:30 AM for delivery today, 9:30 AM–midnight');
    });

    it('shows no delivery line when the seller has set no terms', () => {
      wrap(<SellerPage shop={shopWith(undefined)} ratingsShown={false} />);
      expect(chips().join(' ')).not.toMatch(/delivery/i);
    });

    it('shows the flat fee, and says free delivery for zero, never a made-up fee', () => {
      wrap(
        <SellerPage
          shop={shopWith(undefined, { amount: 995, currency: 'AUD' })}
          ratingsShown={false}
        />,
      );
      expect(chips()).toContain('Delivery A$9.95');
      cleanup();
      wrap(
        <SellerPage
          shop={shopWith(undefined, { amount: 0, currency: 'AUD' })}
          ratingsShown={false}
        />,
      );
      expect(chips()).toContain('Free delivery');
      cleanup();
      wrap(<SellerPage shop={shopWith(undefined)} ratingsShown={false} />);
      expect(chips().join(' ')).not.toMatch(/A\$9\.95|free delivery/i);
    });
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
