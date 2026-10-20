// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { ClosedStoreView } from '../src/errors/closed-store.tsx';
import { NotFoundView } from '../src/errors/not-found-view.tsx';
import { OfflineBanner } from '../src/errors/offline-banner.tsx';
import { OfflinePage } from '../src/errors/offline-page.tsx';
import { UnavailableProductView } from '../src/errors/unavailable-product.tsx';
import { ProductCard } from '../src/home/product-card.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SAMPLE_PRODUCTS } from '../src/storefront/sample-catalog.ts';
import {
  loadClosedStore,
  loadProduct,
  loadSeller,
  loadSellers,
  loadStorefrontContent,
  loadUnavailableProduct,
} from '../src/storefront/source.ts';
import { NO_SELLER_FILTERS } from '../src/sellers/sellers-state.ts';

const refresh = vi.fn();
let path = '/';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => path,
}));

let onLine = true;
Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => onLine });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  onLine = true;
  path = '/';
  refresh.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWith(children: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{children}</StoreProvider>
    </NextIntlClientProvider>,
  );
}

const goOffline = () =>
  act(() => {
    onLine = false;
    window.dispatchEvent(new Event('offline'));
  });

describe('404 page', () => {
  it('focuses the title and offers search, home, Browse products and quick links', async () => {
    const { categories } = await loadStorefrontContent();
    renderWith(<NotFoundView categories={categories} />);
    const title = screen.getByRole('heading', { level: 1, name: 'We cannot find that page' });
    expect(document.activeElement).toBe(title);
    const search = screen.getByRole('search');
    expect(search.getAttribute('action')).toBe('/search');
    expect(within(search).getByRole('searchbox').getAttribute('name')).toBe('q');
    expect(screen.getByRole('link', { name: 'Go to home' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('button', { name: 'Browse products' })).toBeTruthy();
    const links = within(screen.getByRole('navigation', { name: 'Popular pages' }))
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      '/offers',
      '/sellers',
      '/express',
      '/c/meat',
      '/c/poultry',
      '/c/bakery',
    ]);
  });
});

describe('removed product', () => {
  it('is told apart from a listed product and from an unknown id', async () => {
    expect(await loadProduct('lamb-leg-roast')).toBeUndefined();
    expect(await loadUnavailableProduct('lamb-leg-roast')).toBeDefined();
    expect(await loadUnavailableProduct('no-such-product')).toBeUndefined();
    expect(await loadUnavailableProduct(SAMPLE_PRODUCTS[0]!.id)).toBeUndefined();
  });

  it('shows the greyed product, a way to its seller and four similar products', async () => {
    const product = (await loadUnavailableProduct('lamb-leg-roast'))!;
    expect(product.similar).toHaveLength(4);
    expect(product.similar.every((p) => p.category === 'meat')).toBe(true);
    renderWith(<UnavailableProductView product={product} />);
    expect(document.activeElement?.textContent).toBe('This product is no longer available');
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See similar products' }).getAttribute('href')).toBe(
      '#similar',
    );
    expect(
      screen.getByRole('link', { name: 'Visit Kedron Halal Butchers' }).getAttribute('href'),
    ).toBe('/s/kedron');
    const similar = screen.getByRole('region', { name: 'Similar products' });
    expect(within(similar).getAllByRole('article')).toHaveLength(4);
  });
});

describe('closed store', () => {
  it('is told apart from an open store and from an unknown slug', async () => {
    expect(await loadSeller('west-end-grocer')).toBeUndefined();
    expect(await loadClosedStore('west-end-grocer')).toBeDefined();
    expect(await loadClosedStore('no-such-store')).toBeUndefined();
    const open = await loadSellers({ filters: NO_SELLER_FILTERS, sort: 'popular', limit: 100 });
    expect(open.items.map((s) => s.id)).not.toContain('west-end-grocer');
  });

  it('shows its static facts and three other stores that deliver, never a reason', async () => {
    const store = (await loadClosedStore('west-end-grocer'))!;
    expect(store.others).toHaveLength(3);
    expect(store.others.every((s) => s.deliversHere)).toBe(true);
    const { container } = renderWith(<ClosedStoreView store={store} ratingsShown={false} />);
    expect(document.activeElement?.textContent).toBe('This store is not taking orders right now');
    expect(screen.getByText('West End Grocer')).toBeTruthy();
    expect(screen.getByText('West End · Selling since 2025')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse all stores' }).getAttribute('href')).toBe(
      '/sellers',
    );
    const others = screen.getByRole('region', { name: 'Other stores that deliver to you' });
    expect(within(others).getAllByRole('article')).toHaveLength(3);
    expect(container.textContent).not.toMatch(/paused|suspended/i);
  });
});

describe('offline', () => {
  const product = SAMPLE_PRODUCTS.find((p) => p.lowStock === undefined)!;

  it('shows the banner and keeps the cart as it is while the connection is lost', () => {
    renderWith(
      <>
        <OfflineBanner />
        <ProductCard product={product} />
      </>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    goOffline();
    expect(screen.getByRole('status').textContent).toContain('Cart and checkout need a connection');
    const add = screen.getByRole('button', { name: `Add ${product.name} to cart` });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('says it is still offline after Try again, and reads the page again when it is back', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderWith(<OfflineBanner />);
    goOffline();
    onLine = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Checking...' })).toBeTruthy();
    expect(await screen.findByText(/^Still offline/, {}, { timeout: 2000 })).toBeTruthy();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/offline', { method: 'HEAD', cache: 'no-store' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves the banner off the offline page, which says it in full', async () => {
    path = '/offline';
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderWith(
      <>
        <OfflineBanner />
        <OfflinePage />
      </>,
    );
    goOffline();
    expect(screen.getByRole('alert').textContent).toContain('You are offline');
    expect(document.activeElement?.textContent).toBe('You are offline');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText(
        'Still offline. We will try again when your connection is back.',
        {},
        { timeout: 2000 },
      ),
    ).toBeTruthy();
    expect(screen.getAllByText('You are offline')).toHaveLength(1);
  });
});
