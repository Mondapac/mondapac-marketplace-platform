// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import {
  NO_FILTERS,
  listingHref,
  withFlag,
  withValue,
  type ListingState,
} from '../src/catalog/listing-state.ts';
import { RESULTS_HEADING_ID, useSearchSubmit } from '../src/search/search-focus.tsx';
import { SearchPrompt, SearchResults, searchHref } from '../src/search/search-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import {
  LISTING_PAGE_SIZE,
  findProducts,
  findStores,
  listingFacets,
  searchCategories,
} from '../src/storefront/catalog.ts';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: push }) }));

beforeEach(() => {
  push.mockClear();
  // jsdom does not lay out.
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(cleanup);

const START: ListingState = { filters: NO_FILTERS, sort: 'recommended', page: 1 };

const withIntl = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{node}</StoreProvider>
    </NextIntlClientProvider>,
  );

async function renderResults(q: string, state = START, category?: string, tab = 'products') {
  const found = SAMPLE_CONTENT.categories.find((c) => c.code === category);
  const scope = { q, ...(found ? { category: found.code } : {}) };
  const [products, facets, counts, stores] = await Promise.all([
    findProducts({ ...scope, ...state, pageSize: LISTING_PAGE_SIZE }),
    listingFacets(scope),
    searchCategories(q),
    findStores(q),
  ]);
  return withIntl(
    <SearchResults
      query={q}
      {...(found ? { category: found } : {})}
      categories={SAMPLE_CONTENT.categories}
      counts={counts}
      state={state}
      products={products}
      pageSize={LISTING_PAGE_SIZE}
      facets={facets}
      stores={stores}
      tab={tab === 'stores' ? 'stores' : 'products'}
      popular={SAMPLE_CONTENT.popularSearches}
      ratingsShown={false}
    />,
  );
}

describe('search sources', () => {
  it('finds the stores of the matching products and the stores whose name matches', async () => {
    expect((await findStores('halal')).items.map((s) => s.id)).toEqual([
      'kedron',
      'annerley',
      'sunnybank-halal-meats',
    ]);
    expect((await findStores('toowoomba')).items.map((s) => s.id)).toEqual(['toowoomba']);
    expect((await findStores('durian')).items).toEqual([]);
  });

  it('counts the matching products per category, most first', async () => {
    expect(await searchCategories('halal')).toEqual([
      { code: 'meat', count: 5 },
      { code: 'poultry', count: 1 },
    ]);
  });

  it('keeps the search words first in a listing URL', () => {
    const state = withFlag(START, 'special', true);
    expect(listingHref(searchHref('lamb', 'meat'), state)).toBe(
      '/search?q=lamb&category=meat&special=1',
    );
    expect(listingHref(searchHref('a b'), START)).toBe('/search?q=a+b');
  });
});

describe('search results page', () => {
  it('shows the heading, the counts, the tabs and the categories the results fall in', async () => {
    await renderResults('halal');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Results for halal');
    expect(heading.querySelector('q')?.textContent).toBe('halal');
    expect(screen.getByText('6 products · 3 stores')).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Result types' });
    const [products, stores] = within(tabs).getAllByRole('tab');
    expect(products!.getAttribute('aria-selected')).toBe('true');
    expect(products!.textContent).toBe('Products(6)');
    expect(stores!.textContent).toBe('Stores(3)');
    const cats = screen.getByRole('group', { name: 'In categories:' });
    expect(within(cats).getByRole('link', { name: 'Meat (5)' }).getAttribute('href')).toBe(
      '/search?q=halal&category=meat',
    );
    expect(screen.getByText('1 - 6 of 6 results')).toBeTruthy();
    // No breadcrumb, no Recipes tab, and the search filters only.
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(within(tabs).queryByRole('tab', { name: /Recipes/ })).toBeNull();
    const quick = screen.getByRole('group', { name: 'Quick filters' });
    expect(
      within(quick)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Halal', 'Special prices', 'All filters']);
    // Two selects: the phone's copy in the sticky bar and the result bar's (CSS shows one).
    const sort = screen.getAllByRole('combobox')[0]!;
    expect(
      within(sort)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Best match',
      'Best seller',
      'Price (low to high)',
      'Price (high to low)',
      'Name (A to Z)',
    ]);
  });

  it('moves between the tabs with the arrow keys and keeps the tab in the address', async () => {
    await renderResults('halal');
    const [products, stores] = screen.getAllByRole('tab');
    fireEvent.keyDown(products!, { key: 'ArrowRight' });
    expect(stores!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(stores);
    expect(window.location.search).toBe('?tab=stores');
    const panel = screen.getByRole('tabpanel', { name: 'Stores(3)' });
    expect(within(panel).getAllByRole('article')).toHaveLength(3);
    expect(
      within(panel).getByRole('link', { name: 'Kedron Halal Butchers, opens the seller page' }),
    ).toBeTruthy();
    fireEvent.keyDown(stores!, { key: 'Home' });
    expect(products!.getAttribute('aria-selected')).toBe('true');
    expect(window.location.search).toBe('');
  });

  it('opens on Stores when only store names match', async () => {
    await renderResults('toowoomba');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Stores(1)');
    expect(screen.getByText('0 products · 1 store')).toBeTruthy();
  });

  it('shows the category in use as a removable filter and hides the category chips', async () => {
    await renderResults('halal', START, 'meat');
    expect(screen.queryByRole('group', { name: 'In categories:' })).toBeNull();
    const active = screen.getByRole('group', { name: 'Filters in use' });
    expect(
      within(active)
        .getByRole('link', { name: 'Remove filter: Category: Meat' })
        .getAttribute('href'),
    ).toBe('/search?q=halal');
    expect(screen.getByText('1 - 5 of 5 results')).toBeTruthy();
  });

  it('offers Clear all filters when the filters leave nothing', async () => {
    await renderResults('lamb', withValue(START, 'sellers', 'paddington', true));
    expect(screen.getByText('No products match these filters')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear all filters' }).getAttribute('href')).toBe(
      '/search?q=lamb',
    );
  });

  it('shows tips, popular searches and categories when nothing matches', async () => {
    await renderResults('durian');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('No results for “durian”');
    expect(screen.getByText('Check the spelling.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Basmati rice' }).getAttribute('href')).toBe(
      '/search?q=Basmati+rice',
    );
    expect(screen.queryByText(/Did you mean/)).toBeNull();
  });

  it('asks for a search, or for more letters', () => {
    withIntl(<SearchPrompt query="" min={2} popular={SAMPLE_CONTENT.popularSearches} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Search');
    expect(screen.getByText('What are you looking for?')).toBeTruthy();
    cleanup();
    withIntl(<SearchPrompt query="a" min={2} popular={[]} />);
    expect(screen.getByText('Type at least 2 characters')).toBeTruthy();
  });
});

describe('search forms', () => {
  function Form({ onDone }: { readonly onDone: () => void }) {
    const submit = useSearchSubmit(onDone);
    return (
      <form role="search" onSubmit={submit}>
        <input name="q" aria-label="Search" defaultValue="  lamb chops " />
      </form>
    );
  }

  it('closes the panel, hides the keyboard and opens the results', () => {
    const onDone = vi.fn();
    withIntl(<Form onDone={onDone} />);
    const input = screen.getByRole('textbox', { name: 'Search' });
    input.focus();
    fireEvent.submit(screen.getByRole('search'));
    expect(onDone).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(input);
    expect(push).toHaveBeenCalledWith('/search?q=lamb%20chops');
  });

  it('puts focus on the results heading when the results are already open', () => {
    window.history.replaceState(null, '', '/search?q=lamb%20chops');
    withIntl(
      <>
        <h1 id={RESULTS_HEADING_ID} tabIndex={-1}>
          Results
        </h1>
        <Form onDone={() => undefined} />
      </>,
    );
    fireEvent.submit(screen.getByRole('search'));
    expect(push).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe(RESULTS_HEADING_ID);
    window.history.replaceState(null, '', '/');
  });
});
