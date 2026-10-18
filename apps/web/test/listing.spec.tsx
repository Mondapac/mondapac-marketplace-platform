// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { ListingFilters, SortSelect } from '../src/catalog/listing-controls.tsx';
import {
  NO_FILTERS,
  listingHref,
  listingStateOf,
  withFlag,
  withSort,
  withValue,
  type ListingState,
} from '../src/catalog/listing-state.ts';
import { ActiveFilters, NumberedPager, ResultCount, pageWindow } from '../src/catalog/listing.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { findProducts, listingBanner, listingFacets } from '../src/storefront/catalog.ts';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: replace }) }));

beforeEach(() => replace.mockClear());
afterEach(cleanup);

const withIntl = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{node}</StoreProvider>
    </NextIntlClientProvider>,
  );

const START: ListingState = { filters: NO_FILTERS, sort: 'recommended', page: 1 };

describe('listing state in the URL', () => {
  it('reads filters, sort and page, and writes them back in one order', () => {
    const state = listingStateOf({
      price: 'over-20,under-10',
      seller: 'kedron',
      special: '1',
      sort: 'price-asc',
      page: '2',
    });
    expect(state.filters.prices).toEqual(['over-20', 'under-10']);
    expect(listingHref('/c/meat', state)).toBe(
      '/c/meat?special=1&seller=kedron&price=over-20%2Cunder-10&sort=price-asc&page=2',
    );
    expect(listingHref('/c/meat', START)).toBe('/c/meat');
  });

  it('drops values the listing cannot hold', () => {
    const state = listingStateOf({
      special: 'yes',
      seller: ['Bad Id,,kedron,kedron'],
      sort: 'cheapest',
      page: '500',
    });
    expect(state).toEqual({
      filters: { ...NO_FILTERS, sellers: ['kedron'] },
      sort: 'recommended',
      page: 1,
    });
  });

  it('goes back to page 1 when a filter or the sort changes', () => {
    const on3 = { ...START, page: 3 };
    expect(withFlag(on3, 'special', true).page).toBe(1);
    expect(withValue(on3, 'sellers', 'kedron', true).page).toBe(1);
    expect(withSort(on3, 'name').page).toBe(1);
  });
});

describe('listing sample source', () => {
  it('filters by special price, certification, same day, seller and price band', async () => {
    const ids = async (filters: Partial<ListingState['filters']>, category = 'pantry') =>
      (await findProducts({ category, page: 1, filters: { ...NO_FILTERS, ...filters } })).items.map(
        (p) => p.id,
      );
    expect(await ids({ special: true })).toEqual(['basmati', 'honey', 'lentils', 'rose-water']);
    expect(await ids({ certifications: ['halal'] }, 'meat')).toHaveLength(5);
    expect(await ids({ certifications: ['halal'] })).toEqual([]);
    expect(await ids({ sameDay: true }, 'bakery')).toEqual([
      'sourdough',
      'flatbread',
      'croissants',
    ]);
    expect(await ids({ sellers: ['inala'] })).toEqual([
      'medjool',
      'tahini',
      'pistachios',
      'rose-water',
      'date-syrup',
    ]);
    expect(await ids({ prices: ['over-20'] }, 'meat')).toEqual([
      'lamb-shoulder',
      'brisket',
      'lamb-cutlets',
    ]);
  });

  it('sorts, counts the total and pages by 12', async () => {
    const byPrice = await findProducts({ category: 'meat', page: 1, sort: 'price-asc' });
    expect(byPrice.items.map((p) => p.price.amount)).toEqual([1050, 1190, 2490, 2690, 4690]);
    const pantry = await findProducts({ category: 'pantry', page: 2, pageSize: 12 });
    expect(pantry.total).toBe(14);
    expect(pantry.items).toHaveLength(2);
  });

  it('counts each filter option within the category', async () => {
    const facets = await listingFacets({ category: 'meat' });
    expect(facets.special).toBe(2);
    expect(facets.certifications).toEqual([{ id: 'halal', name: 'Halal', count: 5 }]);
    expect(facets.sellers).toEqual([{ id: 'kedron', name: 'Kedron Halal Butchers', count: 5 }]);
    expect(facets.prices.map((p) => [p.id, p.count])).toEqual([
      ['under-10', 0],
      ['10-to-20', 2],
      ['over-20', 3],
    ]);
  });

  it('has a banner only where the content slot holds one', async () => {
    expect((await listingBanner('meat'))?.action.href).toBe('/c/meat?special=1');
    expect(await listingBanner('spices')).toBeUndefined();
  });
});

describe('listing page parts', () => {
  it('lists the filters in use with a link that removes each, and Clear all', async () => {
    const facets = await listingFacets({ category: 'meat' });
    const state = listingStateOf({ special: '1', cert: 'halal', price: 'over-20' });
    withIntl(<ActiveFilters path="/c/meat" state={state} facets={facets} />);
    const group = screen.getByRole('group', { name: 'Filters in use' });
    const links = within(group).getAllByRole('link');
    expect(
      links.map((a) => [a.getAttribute('aria-label') ?? a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Remove filter: Special prices', '/c/meat?cert=halal&price=over-20'],
      ['Remove filter: Halal', '/c/meat?special=1&price=over-20'],
      ['Remove filter: Over A$20', '/c/meat?special=1&cert=halal'],
      ['Clear all', '/c/meat'],
    ]);
  });

  it('counts the results shown', () => {
    withIntl(<ResultCount page={2} pageSize={12} total={14} />);
    expect(screen.getByText('13 - 14 of 14 results')).toBeTruthy();
    cleanup();
    withIntl(<ResultCount page={1} pageSize={12} total={0} />);
    expect(screen.getByText('0 results')).toBeTruthy();
  });

  it('pages with numbers, the current page marked, and keeps the filters', () => {
    const state = { ...listingStateOf({ special: '1' }), page: 1 };
    withIntl(<NumberedPager path="/c/pantry" state={state} pages={2} />);
    const pager = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pager).getByRole('link', { name: 'Page 1' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(pager).getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      '/c/pantry?special=1&page=2',
    );
    expect(
      within(pager).getByRole('link', { name: 'Previous page' }).getAttribute('aria-disabled'),
    ).toBe('true');
    cleanup();
    withIntl(<NumberedPager path="/c/pantry" state={START} pages={1} />);
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
  });

  it('shows the ends and the neighbours of the current page when there are many', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(6, 12)).toEqual([1, 'gap', 5, 6, 7, 'gap', 12]);
    expect(pageWindow(1, 12)).toEqual([1, 2, 'gap', 12]);
  });

  it('toggles a quick filter through the URL', async () => {
    const facets = await listingFacets({ category: 'meat' });
    withIntl(<ListingFilters path="/c/meat" state={START} facets={facets} total={5} />);
    const halal = screen.getByRole('button', { name: 'Halal' });
    expect(halal.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(halal);
    expect(replace).toHaveBeenCalledWith('/c/meat?cert=halal', { scroll: false });
  });

  it('opens the filters drawer, applies a choice and closes on Escape', async () => {
    const facets = await listingFacets({ category: 'meat' });
    const state = listingStateOf({ special: '1' });
    withIntl(<ListingFilters path="/c/meat" state={state} facets={facets} total={2} />);
    const open = screen.getByRole('button', { name: /All filters/ });
    expect(open.textContent).toContain('1 filter on');
    const dialog = screen.getByRole('dialog', { hidden: true, name: 'Filters' });
    expect(dialog.hasAttribute('inert')).toBe(true);
    open.focus();
    fireEvent.click(open);
    expect(dialog.hasAttribute('inert')).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Show 2 results' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Over A\$20/ }));
    expect(replace).toHaveBeenCalledWith('/c/meat?special=1&price=over-20', { scroll: false });
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(dialog.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(open);
  });

  it('sorts from page 1', () => {
    withIntl(<SortSelect path="/c/meat" state={{ ...START, page: 2 }} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), {
      target: { value: 'price-asc' },
    });
    expect(replace).toHaveBeenCalledWith('/c/meat?sort=price-asc', { scroll: false });
  });
});
