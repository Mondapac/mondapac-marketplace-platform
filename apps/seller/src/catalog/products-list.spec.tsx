// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// The address is the list's state: a small store stands in for the router, so a `replace` changes
// what `useSearchParams` answers and the list re-renders the way it does in the app.
const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { search: new URLSearchParams() };
  const router = {
    replace: (url: string) => {
      state.search = new URLSearchParams(url.split('?')[1] ?? '');
      for (const listener of listeners) listener();
    },
  };
  return { listeners, state, router };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRouter: () => nav.router,
    usePathname: () => '/products',
    useSearchParams: () =>
      useSyncExternalStore(
        (onChange) => {
          nav.listeners.add(onChange);
          return () => nav.listeners.delete(onChange);
        },
        () => nav.state.search,
      ),
  };
});
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { ProductsList } from './products-list.tsx';
import {
  addressOf,
  cleanColumns,
  parseQuery,
  queryString,
  DEFAULT_QUERY,
  type CategoryTree,
  type ProductRow,
  type ProductsPage,
} from './products-list-types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const IMAGE = '0190a000-0000-7000-8000-0000000000aa';
const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';

const row = (over: Partial<ProductRow> = {}): ProductRow => ({
  productId: ID,
  productCode: 'P00000184',
  typeCode: 'grocery',
  status: 'published',
  name: 'Olive oil 1L',
  draftName: 'Olive oil 1L',
  primaryImageId: null,
  categoryId: CATEGORY,
  categoryName: 'Pantry',
  offerCount: 6,
  pausedAt: null,
  hasPendingRevision: false,
  lastChangedAt: '2026-10-29T01:00:00.000Z',
  createdAt: '2026-10-01T01:00:00.000Z',
  ...over,
});
const page = (items: ProductRow[], over: Partial<ProductsPage> = {}): ProductsPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  counts: { all: 143, drafts: 12, live: 100, inactive: 31, inReview: 4 },
  ...over,
});
const tree: CategoryTree = {
  categories: [
    { id: CATEGORY, name: 'Pantry', depth: 0 },
    { id: '0190a000-0000-7000-8000-0000000000c2', name: 'Oils', depth: 1 },
  ],
};

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => ProductsPage | 'fail' | 'denied' | 'range' | 'broad') {
  call.mockImplementation((_method, path) => {
    // The saved filters have their own spec: here they are not available, so the list has its
    // built-in tabs only.
    if (path.startsWith('catalog/seller/saved-filters')) {
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    }
    const result = answer(path);
    if (result === 'fail') {
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    }
    if (result === 'denied') {
      return Promise.resolve({ ok: false, failure: { status: 403, code: 'access.denied' } });
    }
    if (result === 'range' || result === 'broad') {
      return Promise.resolve({
        ok: false,
        failure: {
          status: 400,
          code: 'validation.failed',
          details: {
            fields: [
              result === 'range'
                ? { path: 'page', code: 'range' }
                : { path: 'sort', code: 'too-broad' },
            ],
          },
        },
      });
    }
    return Promise.resolve({ ok: true, status: 200, body: result } as never);
  });
}
const listCalls = () =>
  call.mock.calls
    .map((entry) => entry[1])
    .filter((path) => !path.startsWith('catalog/seller/saved-filters'));
// The one-off read of the whole store's size (the subtitle on a filtered address) is not a list read.
const STORE_SIZE = 'catalog/seller/products?view=all&page=1';
const lastList = () =>
  listCalls()
    .filter((path) => path !== STORE_SIZE)
    .at(-1)!;
const address = () => nav.state.search.toString();

const ALL_KEYS = ['catalog.own-product.view', 'catalog.own-product.edit', 'catalog.own-import.run'];

function mount(
  options: {
    readonly keys?: readonly string[];
    readonly paging?: 'pages' | 'prev-next';
    readonly types?: readonly string[];
    readonly categories?: CategoryTree['categories'];
    readonly market?: string;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductsList
        accountId="acc-1"
        marketId={options.market ?? 'AU'}
        timeZone="Australia/Brisbane"
        permissionKeys={options.keys ?? ALL_KEYS}
        csrfToken="csrf-1"
        categories={options.categories ?? tree.categories}
        productTypes={options.types ?? ['grocery', 'electronics']}
        paging={options.paging ?? 'pages'}
      />
    </NextIntlClientProvider>,
  );
}

function open(search = '') {
  nav.state.search = new URLSearchParams(search);
}

function phone(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: !on && query.includes('min-width'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

describe('seller product list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    // @ts-expect-error jsdom has no matchMedia: the list then counts as desktop.
    delete window.matchMedia;
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    open();
  });
  afterEach(() => cleanup());

  it('loads All first, newest change first, page 1, and shows the title, subtitle and tab counts', async () => {
    serve(() => page([row()]));
    mount();
    expect(await screen.findByText('Olive oil 1L')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Products' })).toBeTruthy();
    expect(screen.getByText('143 products in your store')).toBeTruthy();
    expect(lastList()).toBe(
      'catalog/seller/products?view=all&sort=updated&direction=desc&page=1&pageSize=25',
    );
    const tabs = within(screen.getByRole('navigation', { name: 'Product views' }));
    expect(tabs.getByRole('button', { name: 'All (143)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    for (const label of ['Drafts (12)', 'Live (100)', 'Inactive (31)', 'In review (4)']) {
      expect(tabs.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(tabs.getAllByRole('button').map((tab) => tab.textContent?.split(' (')[0])).toEqual([
      'All',
      'Drafts',
      'Live',
      'Inactive',
      'In review',
    ]);
  });

  it('shows Add product and Import with their keys, Import before Add, and nothing without them', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Olive oil 1L');
    expect(screen.getByRole('link', { name: 'Add product' }).getAttribute('href')).toBe(
      '/products/new',
    );
    expect(screen.getByRole('link', { name: 'Import' }).getAttribute('href')).toBe(
      '/products/import',
    );
    expect(screen.queryByText('View only')).toBeNull();
    // Export and Bulk action are the next feature's: the products-saved-export spec covers them.
    expect(screen.getAllByRole('button', { name: /Export|Bulk action/ })).toHaveLength(2);
    cleanup();
    mount({ keys: ['catalog.own-product.view', 'catalog.own-product.edit'] });
    await screen.findByText('Olive oil 1L');
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Add product' })).toBeTruthy();
  });

  it('is read-only for a seller who may only view: a View only banner, no Add, no Import', async () => {
    serve(() => page([row()]));
    mount({ keys: ['catalog.own-product.view'] });
    expect(await screen.findByText('View only')).toBeTruthy();
    expect(screen.getByText('Your role can see products but not add or change them.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add product' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Olive oil 1L' })).toBeTruthy();
  });

  it('shows the default columns: product, status, category, code and last changed', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Olive oil 1L');
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(['', 'Product', 'Status', 'Category', 'Product code', 'Last changed']);
    const cells = within(screen.getAllByRole('row')[1]!);
    expect(cells.getByRole('link', { name: 'Olive oil 1L' }).getAttribute('href')).toBe(
      `/products/${ID}`,
    );
    expect(cells.getByText('Published')).toBeTruthy();
    expect(cells.getByText('Pantry')).toBeTruthy();
    expect(cells.getByText('P00000184')).toBeTruthy();
    expect(cells.getByText('29 Oct 2026')).toBeTruthy();
  });

  it('shows a package tile without a photo and the seller thumbnail route with one', async () => {
    serve(() => page([row(), row({ productId: 'p2', productCode: 'P2', primaryImageId: IMAGE })]));
    const { container } = mount();
    await screen.findAllByText('Olive oil 1L');
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute('src')).toBe(
      `/api/catalog/seller/products/p2/images/${IMAGE}/thumb`,
    );
    expect(container.querySelectorAll('tbody svg').length).toBeGreaterThan(0);
  });

  it('shows the Paused and In review badges beside the status, and a draft name as the name', async () => {
    serve(() =>
      page([
        row({ pausedAt: '2026-10-30T00:00:00.000Z', hasPendingRevision: true }),
        row({
          productId: 'p2',
          status: 'draft',
          name: null,
          draftName: 'My draft',
          categoryName: null,
        }),
        row({ productId: 'p3', status: 'mystery', name: null, draftName: null }),
      ]),
    );
    mount();
    await screen.findByText('My draft');
    const first = within(screen.getAllByRole('row')[1]!);
    expect(first.getByText('Published')).toBeTruthy();
    expect(first.getByText('Paused')).toBeTruthy();
    expect(first.getByText('In review')).toBeTruthy();
    const second = within(screen.getAllByRole('row')[2]!);
    expect(second.getByText('Draft')).toBeTruthy();
    expect(second.getByText('No category')).toBeTruthy();
    expect(second.queryByText('Paused')).toBeNull();
    const third = within(screen.getAllByRole('row')[3]!);
    expect(third.getByText('Unknown')).toBeTruthy();
    expect(third.getByText('Unnamed product')).toBeTruthy();
  });

  it('switches view, back to page 1, keeps it in the address and asks for that view', async () => {
    open('page=3');
    serve((url) =>
      url.includes('view=in-review')
        ? page([row({ hasPendingRevision: true })])
        : page([row()], { total: 80 }),
    );
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(screen.getByRole('button', { name: /^In review/ }));
    await waitFor(() => expect(lastList()).toContain('view=in-review'));
    expect(lastList()).toContain('page=1');
    expect(address()).toBe('view=in-review');
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    await waitFor(() => expect(address()).toBe(''));
  });

  it('opens the list an address describes and keeps every part of it in the address', async () => {
    const search = `view=drafts&q=oil&status=draft&categoryId=${CATEGORY}&paused=true&typeCode=grocery&sort=name&direction=desc&page=2&pageSize=50`;
    open(search);
    serve(() => page([row()], { page: 2, pageSize: 50, total: 120 }));
    mount();
    await screen.findByText('Olive oil 1L');
    const sent = new URLSearchParams(lastList().split('?')[1]);
    expect(Object.fromEntries(sent)).toEqual({
      view: 'drafts',
      q: 'oil',
      status: 'draft',
      categoryId: CATEGORY,
      paused: 'true',
      typeCode: 'grocery',
      sort: 'name',
      direction: 'desc',
      page: '2',
      pageSize: '50',
    });
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('oil');
    expect(screen.getByRole('button', { name: /^Drafts/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('Status is Draft')).toBeTruthy();
    expect(screen.getByText('Category is Pantry')).toBeTruthy();
    expect(screen.getByText('Paused is Yes')).toBeTruthy();
    expect(screen.getByText('Product type is grocery')).toBeTruthy();
    expect(screen.getByText('Sorted by Name: Z to A')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (4)' })).toBeTruthy();
    expect(screen.getByText('51–51 of 120 products')).toBeTruthy();
  });

  it('searches after a pause, sends the term, keeps it in the address, shows the match count and Clear all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve((url) => (url.includes('q=oil') ? page([row()], { total: 14 }) : page([row()])));
      mount();
      await screen.findByText('Olive oil 1L');
      expect(
        screen.getByRole('searchbox', { name: 'Search products' }).getAttribute('placeholder'),
      ).toBe('Search by product name or code');
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' oil ' } });
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => expect(lastList()).toContain('q=oil'));
      expect(address()).toBe('q=oil');
      expect(await screen.findByText('14 products match')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => expect(lastList()).not.toContain('q='));
      expect(address()).toBe('');
      expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('');
      expect(screen.queryByText('14 products match')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('limits the search to 100 characters', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Olive oil 1L');
    expect(screen.getByRole('searchbox').getAttribute('maxlength')).toBe('100');
  });

  it('builds a filter of the four fields, applied as chips with the match count, removed one by one', async () => {
    serve(() => page([row()], { total: 3 }));
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    const field = () => within(panel).getAllByLabelText('Field');
    const value = () => within(panel).getAllByLabelText('Value');
    expect(
      within(field()[0]!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Field', 'Status', 'Category', 'Paused', 'Product type']);
    fireEvent.change(field()[0]!, { target: { value: 'status' } });
    fireEvent.change(value()[0]!, { target: { value: 'unpublished' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    // A field already used is not offered again.
    expect(within(field()[1]!).queryByRole('option', { name: 'Status' })).toBeNull();
    fireEvent.change(field()[1]!, { target: { value: 'categoryId' } });
    fireEvent.change(value()[1]!, { target: { value: CATEGORY } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(field()[2]!, { target: { value: 'paused' } });
    fireEvent.change(value()[2]!, { target: { value: 'false' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(field()[3]!, { target: { value: 'typeCode' } });
    expect(
      within(value()[3]!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Value', 'grocery', 'electronics']);
    fireEvent.change(value()[3]!, { target: { value: 'electronics' } });
    expect(within(panel).queryByRole('button', { name: 'Add condition' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(lastList()).toContain(
        `status=unpublished&categoryId=${CATEGORY}&paused=false&typeCode=electronics`,
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(address()).toBe(
      `status=unpublished&categoryId=${CATEGORY}&paused=false&typeCode=electronics`,
    );
    expect(screen.getByText('Status is Not published')).toBeTruthy();
    expect(screen.getByText('Category is Pantry')).toBeTruthy();
    expect(screen.getByText('Paused is No')).toBeTruthy();
    expect(screen.getByText('Product type is electronics')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (4)' })).toBeTruthy();
    expect(await screen.findByText('3 products match')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status is Not published' }));
    await waitFor(() => expect(lastList()).not.toContain('status='));
    expect(lastList()).toContain(`categoryId=${CATEGORY}`);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(address()).toBe(''));
  });

  it('leaves out the Category and Product type filters when their values did not load', async () => {
    serve(() => page([row()]));
    mount({ categories: [], types: [] });
    await screen.findByText('Olive oil 1L');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    expect(
      within(within(panel).getByLabelText('Field'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Field', 'Status', 'Paused']);
  });

  it('sorts by name, A to Z first, and by the other direction, and by Created', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Olive oil 1L');
    expect(screen.getByText('Sorted by Last changed: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    expect(
      within(panel)
        .getAllByRole('radio')
        .slice(0, 3)
        .map((radio) => (radio as HTMLInputElement).labels?.[0]?.textContent),
    ).toEqual(['Name', 'Last changed', 'Created']);
    fireEvent.click(within(panel).getByRole('radio', { name: 'Name' }));
    await waitFor(() => expect(lastList()).toContain('sort=name&direction=asc'));
    expect(address()).toBe('sort=name');
    fireEvent.click(within(panel).getByRole('radio', { name: 'Z to A' }));
    await waitFor(() => expect(lastList()).toContain('sort=name&direction=desc'));
    expect(address()).toBe('sort=name&direction=desc');
    expect(screen.getByText('Sorted by Name: Z to A')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Created' }));
    await waitFor(() => expect(lastList()).toContain('sort=created&direction=desc'));
    expect(address()).toBe('sort=created');
  });

  it('keeps the column choice for this account in storage, in order, and shows the columns', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    // Product, Status and Category are fixed; Code and Last changed are on, the rest off.
    for (const name of ['Product', 'Status', 'Category']) {
      expect(within(panel).getByText(name)).toBeTruthy();
    }
    expect(
      within(panel).getByRole<HTMLInputElement>('checkbox', { name: 'Product code' }).checked,
    ).toBe(true);
    expect(
      within(panel).getByRole<HTMLInputElement>('checkbox', { name: 'Last changed' }).checked,
    ).toBe(true);
    for (const name of ['Created', 'Offers', 'Product type']) {
      expect(within(panel).getByRole<HTMLInputElement>('checkbox', { name }).checked).toBe(false);
    }
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Offers' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Product code' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Move Offers up' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(
      JSON.parse(window.localStorage.getItem('mp:seller:AU:acc-1:products-columns') ?? 'null'),
    ).toEqual(['offers', 'updated']);
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      '',
      'Product',
      'Status',
      'Category',
      'Offers',
      'Last changed',
    ]);
    // Without the Code column, the code sits under the name.
    expect(screen.getByText('P00000184')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy();
  });

  it('restores a saved choice on load, drops unknown ids, keys it by Market and account, and resets', async () => {
    window.localStorage.setItem(
      'mp:seller:ZZ:acc-1:products-columns',
      JSON.stringify(['type', 'nope', 'created', 'type']),
    );
    window.localStorage.setItem('mp:seller:AU:acc-1:products-columns', JSON.stringify(['offers']));
    serve(() => page([row()]));
    mount({ market: 'ZZ' });
    await screen.findByText('Olive oil 1L');
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      '',
      'Product',
      'Status',
      'Category',
      'Product type',
      'Created',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset to default' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      '',
      'Product',
      'Status',
      'Category',
      'Product code',
      'Last changed',
    ]);
  });

  it('still works when storage is missing or refuses', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      serve(() => page([row()]));
      mount();
      await screen.findByText('Olive oil 1L');
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      const panel = await screen.findByRole('dialog', { name: 'Columns' });
      fireEvent.click(within(panel).getByRole('checkbox', { name: 'Created' }));
      fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
      expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toContain(
        'Created',
      );
    } finally {
      spy.mockRestore();
      set.mockRestore();
    }
  });

  it('pages with page numbers: the range, the total, numbers with a gap, and a click on a page', async () => {
    serve((url) =>
      url.includes('page=3')
        ? page([row({ name: 'Third page' })], { page: 3, total: 143 })
        : page([row()], { total: 143 }),
    );
    mount();
    await screen.findByText('Olive oil 1L');
    expect(screen.getByText('1–1 of 143 products')).toBeTruthy();
    const pages = within(screen.getByRole('navigation', { name: 'Pages' }));
    expect(pages.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(
      ['Previous', 'Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5', 'Page 6', 'Next'],
    );
    expect(pages.getByRole('button', { name: 'Page 1' }).getAttribute('aria-current')).toBe('page');
    expect(pages.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(pages.getByRole('button', { name: 'Page 3' }));
    expect(await screen.findByText('Third page')).toBeTruthy();
    expect(lastList()).toContain('page=3');
    expect(address()).toBe('page=3');
    expect(screen.getByText('51–51 of 143 products')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(address()).toBe('page=4'));
  });

  it('changes rows per page to 50 or 100 and returns to page 1', async () => {
    open('page=2');
    serve(() => page([row()], { total: 143, page: 2 }));
    mount();
    await screen.findByText('Olive oil 1L');
    const size = screen.getByLabelText<HTMLSelectElement>('Rows per page');
    expect([...size.options].map((option) => option.value)).toEqual(['25', '50', '100']);
    fireEvent.change(size, { target: { value: '100' } });
    await waitFor(() => expect(lastList()).toContain('page=1&pageSize=100'));
    expect(address()).toBe('pageSize=100');
  });

  it('pages with Previous and Next only when the Market setting says so, or could not be read', async () => {
    serve((url) =>
      url.includes('page=2')
        ? page([row({ name: 'Second page' })], { page: 2, total: 26 })
        : page([row()], { total: 26 }),
    );
    mount({ paging: 'prev-next' });
    await screen.findByText('Olive oil 1L');
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second page')).toBeTruthy();
    expect(lastList()).toContain('page=2');
    expect(screen.getByText('26–26 of 26 products')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  });

  it.each(['pages', 'prev-next'] as const)(
    'stops at row 10,000 with "Narrow the list to see more." (%s)',
    async (paging) => {
      open('page=400');
      serve(() => page([row()], { page: 400, total: 12408 }));
      mount({ paging });
      await screen.findByText('Olive oil 1L');
      expect(screen.getByText('Narrow the list to see more.')).toBeTruthy();
      expect(screen.getByText('9,976–9,976 of 12,408 products')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
      if (paging === 'pages') {
        expect(screen.queryByRole('button', { name: 'Page 401' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Page 400' })).toBeTruthy();
      }
    },
  );

  it('does not say it before the last reachable page', async () => {
    serve(() => page([row()], { total: 12408 }));
    mount();
    await screen.findByText('Olive oil 1L');
    expect(screen.queryByText('Narrow the list to see more.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false);
  });

  it('opens page 1 when the API refuses a page past row 10,000', async () => {
    open('page=401&view=live');
    serve((url) => (url.includes('page=401') ? 'range' : page([row()])));
    mount();
    await waitFor(() => expect(address()).toBe('view=live'));
    expect(await screen.findByText('Olive oil 1L')).toBeTruthy();
  });

  it('opens the last page when the page asked for is past the rows', async () => {
    open('page=9');
    serve((url) =>
      url.includes('page=9')
        ? page([], { page: 9, total: 60 })
        : page([row()], { page: 3, total: 60 }),
    );
    mount();
    await waitFor(() => expect(address()).toBe('page=3'));
  });

  it('shows skeleton rows while loading, with the tabs and toolbar in place', () => {
    call.mockImplementation(() => new Promise(() => undefined));
    mount();
    expect(screen.getByText('Loading products').closest('[role="status"]')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Product views' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search products' })).toBeTruthy();
  });

  it('shows the error banner with Try again, and the list after a retry', async () => {
    let fail = true;
    serve(() => (fail ? 'fail' : page([row()])));
    mount();
    expect(await screen.findByText('Products could not be loaded')).toBeTruthy();
    expect(screen.getByText(/Try again\. If it keeps happening/)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Olive oil 1L')).toBeTruthy();
    expect(screen.queryByText('Products could not be loaded')).toBeNull();
  });

  it('says so, without a retry, when the API refuses the seller', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You don’t have access to products.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('sends the seller to sign in again when the session has ended', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, assign },
      configurable: true,
    });
    try {
      call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
      mount();
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });

  it('refuses a name sort over too many products with a message and no retry', async () => {
    open('sort=name');
    serve(() => 'broad');
    mount();
    expect(
      await screen.findByText(
        'Too many products to sort by name. Narrow the search or sort by date.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the empty state of a store with no products, with Add product only for who may add', async () => {
    serve(() => page([], { counts: { all: 0, drafts: 0, live: 0, inactive: 0, inReview: 0 } }));
    mount();
    expect(await screen.findByText('No products yet')).toBeTruthy();
    expect(screen.getByText('Add a product or import a list to start your store.')).toBeTruthy();
    // Add product is shown once, in the empty card (the header keeps Import).
    expect(screen.getAllByRole('link', { name: 'Add product' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Add product' }).closest('table')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import' })).toBeTruthy();
    cleanup();
    mount({ keys: ['catalog.own-product.view'] });
    expect(await screen.findByText('No products yet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add product' })).toBeNull();
  });

  it('keeps the header Add product when a filter matches nothing in a store that has products', async () => {
    open('q=zzz');
    serve(() =>
      page([], { total: 0, counts: { all: 0, drafts: 0, live: 0, inactive: 0, inReview: 0 } }),
    );
    mount();
    expect(await screen.findByText('No products match')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Add product' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Add product' })?.closest('table')).toBeNull();
  });

  it('says so for an empty view of a store that has products', async () => {
    open('view=drafts');
    serve(() => page([], { counts: { all: 5, drafts: 0, live: 5, inactive: 0, inReview: 0 } }));
    mount();
    expect(await screen.findByText('No drafts')).toBeTruthy();
    expect(screen.queryByText('No products yet')).toBeNull();
  });

  it('shows "No products match" with Clear all after a search with no result', async () => {
    open('q=zzz');
    serve((url) => (url.includes('q=zzz') ? page([], { total: 0 }) : page([row()])));
    mount();
    expect(await screen.findByText('No products match')).toBeTruthy();
    expect(screen.getByText('Try another search or remove a filter.')).toBeTruthy();
    expect(screen.getByText('0 products match')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[1]!);
    expect(await screen.findByText('Olive oil 1L')).toBeTruthy();
    expect(address()).toBe('');
  });

  it('counts the whole store in the subtitle even on a filtered address', async () => {
    open('status=draft');
    serve((url) =>
      url.includes('status=draft')
        ? page([row()], {
            total: 12,
            counts: { all: 12, drafts: 12, live: 0, inactive: 0, inReview: 1 },
          })
        : page([row()]),
    );
    mount();
    expect(await screen.findByText('143 products in your store')).toBeTruthy();
    expect(call.mock.calls.filter((entry) => entry[1] === STORE_SIZE)).toHaveLength(1);
  });

  it('is cards with Filter and Sort in a bottom sheet, and no Columns control, below 1024 px', async () => {
    phone(true);
    serve(() => page([row()]));
    mount();
    await screen.findByText('Olive oil 1L');
    expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filter products' });
    fireEvent.change(within(sheet).getByLabelText('Field'), { target: { value: 'paused' } });
    fireEvent.change(within(sheet).getByLabelText('Value'), { target: { value: 'true' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastList()).toContain('paused=true'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Filter (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const sort = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(sort).getByRole('radio', { name: 'Name' }));
    await waitFor(() => expect(lastList()).toContain('sort=name'));
    fireEvent.click(within(sort).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('product list address and query', () => {
  const params = (text: string) => new URLSearchParams(text);

  it('reads the defaults from an empty address', () => {
    expect(parseQuery(params(''))).toEqual(DEFAULT_QUERY);
  });

  it('drops what is unknown or malformed instead of breaking', () => {
    expect(
      parseQuery(
        params(
          'view=nope&status=withdrawn&categoryId=x&paused=maybe&typeCode=a%20b&sort=price&direction=up&page=-2&pageSize=30&q=%20%20',
        ),
      ),
    ).toEqual(DEFAULT_QUERY);
    expect(parseQuery(params('page=abc')).page).toBe(1);
    expect(parseQuery(params(`q=${'x'.repeat(150)}`)).q).toHaveLength(100);
  });

  it('starts a name sort A to Z and the other sorts newest first', () => {
    expect(parseQuery(params('sort=name')).direction).toBe('asc');
    expect(parseQuery(params('sort=created')).direction).toBe('desc');
    expect(parseQuery(params('sort=name&direction=desc')).direction).toBe('desc');
  });

  it('writes only what differs from the defaults, and always sends page=1 to the API', () => {
    expect(addressOf(DEFAULT_QUERY)).toBe('');
    expect(addressOf({ ...DEFAULT_QUERY, view: 'live', page: 2, pageSize: 100 })).toBe(
      'view=live&page=2&pageSize=100',
    );
    expect(queryString(DEFAULT_QUERY)).toBe(
      'view=all&sort=updated&direction=desc&page=1&pageSize=25',
    );
    expect(queryString({ ...DEFAULT_QUERY, q: 'oil', filters: { paused: 'true' } })).toContain(
      'q=oil&paused=true',
    );
  });

  it('cleans a saved column list: nothing saved is the default, an empty list is a choice', () => {
    expect(cleanColumns(undefined)).toEqual(['code', 'updated']);
    expect(cleanColumns([])).toEqual([]);
    expect(cleanColumns(['type', 'x', 3, 'type', 'offers'])).toEqual(['type', 'offers']);
  });
});
