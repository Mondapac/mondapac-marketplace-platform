// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { SELLERS_PAGE_SIZE, SellersPage } from '../src/sellers/sellers-page.tsx';
import {
  NO_SELLER_FILTERS,
  sellersHref,
  sellersStateOf,
  withDistance,
  withSellerFlag,
  withSellersPage,
  type SellersState,
} from '../src/sellers/sellers-state.ts';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SELLER_RATINGS_SHOWN } from '../src/storefront/features.ts';
import { sampleSellers } from '../src/storefront/sample-sellers.ts';
import { loadSeller, loadSellers } from '../src/storefront/source.ts';
import type { BuyerLocation, SellerResults } from '../src/storefront/types.ts';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: replace }) }));

beforeEach(() => replace.mockClear());
afterEach(cleanup);

const START: SellersState = { filters: NO_SELLER_FILTERS, sort: 'popular', page: 1 };

const read = (state: SellersState, location?: BuyerLocation) =>
  sampleSellers(
    { filters: state.filters, sort: state.sort, limit: state.page * SELLERS_PAGE_SIZE },
    location,
  );

function renderPage(results: SellerResults, state = START, ratingsShown = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <SellersPage results={results} state={state} ratingsShown={ratingsShown} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

const cardNames = () => screen.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent);
const card = (name: string) =>
  screen
    .getByRole('heading', { level: 3, name: `${name}, opens the seller page` })
    .closest('article') as HTMLElement;

describe('sellers state in the URL', () => {
  it('reads filters, distance, sort and page, and writes them back in one order', () => {
    const state = sellersStateOf(
      { cat: 'meat,bakery', min: 'none', cert: 'halal', km: '10', sort: 'nearest', page: '2' },
      true,
    );
    expect(state.filters.categories).toEqual(['bakery', 'meat']);
    expect(state.filters.distance).toBe(10);
    expect(sellersHref('/sellers', state)).toBe(
      '/sellers?cert=halal&cat=bakery%2Cmeat&min=none&km=10&sort=nearest&page=2',
    );
    expect(sellersHref('/sellers', START)).toBe('/sellers');
  });

  it('drops distance and Nearest first when the location is not inside the delivery area', () => {
    const state = sellersStateOf({ km: '10', sort: 'nearest' }, false);
    expect(state.filters.distance).toBeUndefined();
    expect(state.sort).toBe('popular');
  });

  it('drops values the page cannot hold, and goes back to the first 12 on a change', () => {
    expect(sellersStateOf({ km: '7', sort: 'cheapest', page: '500', new: 'yes' }, true)).toEqual(
      START,
    );
    const later = withSellersPage(START, 3);
    expect(withSellerFlag(later, 'sameDay', true).page).toBe(1);
    expect(withDistance(later, 5).page).toBe(1);
  });
});

describe('sellers sample source', () => {
  it('reads through the storefront source', async () => {
    const results = await loadSellers({ filters: NO_SELLER_FILTERS, sort: 'popular', limit: 12 });
    expect(results.items).toHaveLength(12);
    expect(results.total).toBe(18);
    expect(results.location).toBe('inside');
  });

  it('links every store to a seller page that exists', async () => {
    const { items } = read({ ...START, page: 2 });
    expect(items).toHaveLength(18);
    for (const store of items) expect(await loadSeller(store.id), store.id).toBeDefined();
  });

  it('labels a store halal only from its approved certificate', () => {
    const { items } = read({ ...START, page: 2 });
    const halal = items.filter((s) => s.certifications.some((c) => c.type === 'halal'));
    expect(halal.map((s) => s.id).sort()).toEqual([
      'annerley',
      'kedron',
      'sunnybank-halal-meats',
      'wynnum',
    ]);
  });

  it('filters by label, same day, new sellers, category, minimum order and distance', () => {
    const ids = (state: SellersState) =>
      read(state)
        .items.map((s) => s.id)
        .sort();
    const f = NO_SELLER_FILTERS;
    expect(ids({ ...START, filters: { ...f, newSellers: true } })).toEqual([
      'coorparoo',
      'redcliffe',
      'sherwood',
    ]);
    expect(ids({ ...START, filters: { ...f, minimums: ['none'] } })).toEqual(
      ['carindale', 'coorparoo', 'inala', 'logan-road', 'paddington'].sort(),
    );
    expect(ids({ ...START, filters: { ...f, categories: ['bakery'] } })).toEqual([
      'carindale',
      'indooroopilly',
      'paddington',
    ]);
    expect(ids({ ...START, filters: { ...f, distance: 5 } })).toEqual([
      'annerley',
      'coorparoo',
      'kedron',
      'paddington',
    ]);
    expect(ids({ ...START, filters: { ...f, sameDay: true, certifications: ['halal'] } })).toEqual([
      'annerley',
      'sunnybank-halal-meats',
    ]);
  });

  it('sorts by popularity, name, newest and distance', () => {
    const first = (sort: SellersState['sort']) => read({ ...START, sort }).items[0]!.id;
    expect(first('popular')).toBe('sunnybank-halal-meats');
    expect(first('name')).toBe('annerley');
    expect(read({ ...START, sort: 'newest' }).items[0]!.sellingSince).toBe(2026);
    expect(first('nearest')).toBe('kedron');
  });

  it('gives no distance, distance filter or nearest order outside the delivery area', () => {
    const results = read(
      { filters: { ...NO_SELLER_FILTERS, distance: 5 }, sort: 'nearest', page: 1 },
      'outside',
    );
    expect(results.total).toBe(18);
    expect(results.facets.distances).toEqual([]);
    expect(results.items.every((s) => s.distanceKm === undefined && s.deliversHere)).toBe(true);
    expect(results.items[0]!.id).toBe('sunnybank-halal-meats');
  });
});

describe('sellers page', () => {
  it('has a hidden page title, starts with All stores and shows 12 with Show more', () => {
    renderPage(read(START));
    const h1 = screen.getByRole('heading', { level: 1, name: 'Sellers' });
    expect(h1.className).toBe('sr-only');
    expect(screen.getByRole('heading', { level: 2, name: 'All stores' })).toBeTruthy();
    expect(screen.queryByText(/Closest to you/)).toBeNull();
    expect(cardNames()).toHaveLength(12);
    expect(screen.getByText('18 stores')).toBeTruthy();
    const more = screen.getByRole('link', { name: 'Show more (6)' });
    expect(more.getAttribute('href')).toBe('/sellers?page=2');
  });

  it('shows the rest after Show more, focuses the first new store, and has no button at the end', () => {
    const state = withSellersPage(START, 2);
    renderPage(read(state), state);
    expect(cardNames()).toHaveLength(18);
    expect(screen.queryByRole('link', { name: /Show more/ })).toBeNull();
    const links = document.querySelectorAll('.sl-grid .slc h3 a');
    expect(document.activeElement).toBe(links[12]);
  });

  it('draws a store card: link to the seller page, city and year, chips, terms and products', () => {
    renderPage(read(START));
    const kedron = card('Kedron Halal Butchers');
    const link = within(kedron).getByRole('link');
    expect(link.getAttribute('href')).toBe('/s/kedron');
    expect(link.getAttribute('aria-label')).toBe('Kedron Halal Butchers, opens the seller page');
    expect(kedron.textContent).toContain('Kedron · Selling since 2025');
    expect(kedron.textContent).toContain('Halal certificate checked');
    expect(kedron.textContent).toContain('A$40.00 minimum order');
    expect(kedron.textContent).toContain('6 products');
    expect(kedron.querySelectorAll('.slc-th')).toHaveLength(3);
    expect(card('Paddington Bakehouse').textContent).toContain('No minimum order');
  });

  it('marks new sellers and stores that do not deliver to the location', () => {
    const state = withSellersPage(START, 2);
    renderPage(read(state), state);
    expect(card('Coorparoo Pantry').textContent).toContain('New seller');
    expect(card('Toowoomba Farm Direct').textContent).toContain('Outside your delivery area');
    expect(card('Kedron Halal Butchers').textContent).not.toContain('Outside your delivery area');
  });

  it('hides the satisfaction line unless ratings are shown', () => {
    expect(SELLER_RATINGS_SHOWN).toBe(false);
    renderPage(read(START));
    expect(screen.queryByText(/satisfaction/)).toBeNull();
    cleanup();
    renderPage(read(START), START, true);
    const line = within(card('Kedron Halal Butchers')).getByRole('img', {
      name: '96 percent satisfaction, 214 ratings',
    });
    expect(line.textContent).toContain('96% satisfaction');
  });

  it('offers Nearest first and the Distance filter only inside the delivery area', () => {
    renderPage(read(START));
    const sort = screen.getByRole('combobox', { name: 'Sort by' });
    expect([...sort.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Most popular',
      'Nearest first',
      'Name (A to Z)',
      'Newest',
    ]);
    const dialog = screen.getByRole('dialog', { hidden: true, name: 'Filters' });
    expect(within(dialog).queryByText('Distance')).toBeTruthy();
    cleanup();
    renderPage(read(START, 'outside'));
    expect(
      [...screen.getByRole('combobox', { name: 'Sort by' }).querySelectorAll('option')].map(
        (o) => o.value,
      ),
    ).toEqual(['popular', 'name', 'newest']);
    expect(
      within(screen.getByRole('dialog', { hidden: true, name: 'Filters' })).queryByText('Distance'),
    ).toBeNull();
    expect(screen.queryByText('Outside your delivery area')).toBeNull();
  });

  it('applies a quick filter and a drawer choice through the URL', () => {
    renderPage(read(START));
    fireEvent.click(screen.getByRole('button', { name: 'Halal' }));
    expect(replace).toHaveBeenCalledWith('/sellers?cert=halal', { scroll: false });
    const open = screen.getByRole('button', { name: /All filters/ });
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(dialog).getByRole('button', { name: 'Show 18 stores' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Within 10 km/ }));
    expect(replace).toHaveBeenLastCalledWith('/sellers?km=10', { scroll: false });
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(document.activeElement).toBe(open);
  });

  it('lists the filters in use with links that remove them', () => {
    const state = sellersStateOf({ km: '5', min: 'up-to-30', sameday: '1' }, true);
    renderPage(read(state), state);
    const used = screen.getByRole('group', { name: 'Filters in use' });
    const links = within(used).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Within 5 km',
      'Same day',
      'Up to A$30',
      'Clear all',
    ]);
    expect(links[0]!.getAttribute('href')).toBe('/sellers?sameday=1&min=up-to-30');
    expect(links.at(-1)!.getAttribute('href')).toBe('/sellers');
  });

  it('shows the no-match state with Clear all filters', () => {
    const state = sellersStateOf({ new: '1', cert: 'halal' }, true);
    renderPage(read(state), state);
    expect(screen.getByRole('heading', { name: 'No stores match these filters' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear all filters' }).getAttribute('href')).toBe(
      '/sellers',
    );
    expect(screen.getByText('0 stores')).toBeTruthy();
  });

  it('shows the no-sellers state with Browse products', () => {
    const empty: SellerResults = { ...read(START), items: [], total: 0, all: 0 };
    renderPage(empty);
    expect(screen.getByRole('heading', { level: 2, name: 'No sellers yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Browse products' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'All stores' })).toBeNull();
  });
});
