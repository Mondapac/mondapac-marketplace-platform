// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { ProductsList } from './products-list.tsx';
import {
  cleanColumns,
  queryString,
  DEFAULT_QUERY,
  type CategoryTree,
  type ProductRow,
  type ProductsPage,
} from './products-types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const IMAGE = '0190a000-0000-7000-8000-0000000000aa';
const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';

const row = (over: Partial<ProductRow> = {}): ProductRow => ({
  productId: ID,
  productCode: 'AU-000184',
  name: 'Lamb cutlets 500 g',
  primaryImageId: null,
  scope: 'SELLER',
  ownerSellerId: '0190a000-0000-7000-8000-0000000000b1',
  ownerStoreName: 'Cedar Lane Halal Meats',
  categoryId: CATEGORY,
  categoryName: 'Meat',
  typeCode: 'simple',
  status: 'published',
  offerCount: 6,
  updatedAt: '2026-10-29T01:00:00.000Z',
  createdAt: '2026-10-01T01:00:00.000Z',
  ...over,
});
const page = (items: ProductRow[], over: Partial<ProductsPage> = {}): ProductsPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  counts: { active: 1148, all: 1284, inactive: 136 },
  ...over,
});
const tree: CategoryTree = {
  categories: [
    { id: CATEGORY, name: 'Meat', depth: 0 },
    { id: '0190a000-0000-7000-8000-0000000000c2', name: 'Lamb', depth: 1 },
  ],
};

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => ProductsPage | 'fail' | 'denied') {
  call.mockImplementation((_method, path) => {
    if (path === 'catalog/categories') {
      return Promise.resolve({ ok: true, status: 200, body: tree } as never);
    }
    const result = answer(path);
    if (result === 'fail') {
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    }
    if (result === 'denied') {
      return Promise.resolve({ ok: false, failure: { status: 403, code: 'access.denied' } });
    }
    return Promise.resolve({ ok: true, status: 200, body: result } as never);
  });
}
const listCalls = () =>
  call.mock.calls.map((entry) => entry[1]).filter((path) => path.startsWith('catalog/admin'));
const lastList = () => listCalls()[listCalls().length - 1]!;

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductsList accountId="acc-1" marketId="AU" timeZone="Australia/Brisbane" />
    </NextIntlClientProvider>,
  );
}

describe('admin product list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });
  afterEach(cleanup);

  it('loads the Active tab first, newest change first, and shows the tab counts', async () => {
    serve(() => page([row()]));
    mount();
    expect(await screen.findByText('Lamb cutlets 500 g')).toBeTruthy();
    expect(listCalls()[0]).toBe(
      'catalog/admin/products?view=active&sort=updated&direction=desc&page=1&pageSize=25',
    );
    expect(
      screen.getByRole('button', { name: 'Active (1,148)' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'All (1,284)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inactive (136)' })).toBeTruthy();
    expect(screen.getByText('Sorted by Last changed: Newest first')).toBeTruthy();
    // No "Products" heading over the tabs (the topbar names the page), no selection, no write actions.
    expect(screen.queryByRole('heading', { name: 'Products' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    for (const absent of ['Bulk action', 'Import', 'Add product', 'Manage filters']) {
      expect(screen.queryByText(absent)).toBeNull();
    }
  });

  it('shows the four fixed columns by default: product with code, category, status', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['Product', 'Category', 'Status']);
    const body = screen.getAllByRole('row')[1]!;
    expect(within(body).getByText('AU-000184')).toBeTruthy();
    expect(within(body).getByText('Meat')).toBeTruthy();
    expect(within(body).getByText('Active')).toBeTruthy();
  });

  it('shows a package tile without a photo and the thumbnail route with one', async () => {
    serve(() =>
      page([
        row(),
        row({ productId: '0190a000-0000-7000-8000-000000000002', primaryImageId: IMAGE }),
      ]),
    );
    const { container } = mount();
    await screen.findAllByText('Lamb cutlets 500 g');
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute('src')).toBe(
      `/api/catalog/admin/products/0190a000-0000-7000-8000-000000000002/images/${IMAGE}/thumb`,
    );
    expect(images[0]!.getAttribute('alt')).toBe('');
    // A photo that fails to load falls back to the tile.
    fireEvent.error(images[0]!);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('switches tab, back to the first page, and asks for that tab', async () => {
    serve((url) =>
      url.includes('view=inactive') ? page([row({ status: 'withdrawn' })]) : page([row()]),
    );
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    fireEvent.click(screen.getByRole('button', { name: /^Inactive/ }));
    expect(await screen.findByText('Withdrawn')).toBeTruthy();
    expect(lastList()).toContain('view=inactive');
    expect(lastList()).toContain('page=1');
  });

  it('searches after a pause and sends the term, with the match count and Clear all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve((url) => (url.includes('q=lamb') ? page([row()], { total: 14 }) : page([row()])));
      mount();
      await screen.findByText('Lamb cutlets 500 g');
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search products' }), {
        target: { value: ' lamb ' },
      });
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => expect(lastList()).toContain('q=lamb'));
      expect(await screen.findByText('14 products match')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => expect(lastList()).not.toContain('q='));
      expect(screen.queryByText('14 products match')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a filter: status and category, applied as chips, removed one by one', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'status' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'withdrawn' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const fields = within(panel).getAllByLabelText('Field');
    // A field already used is not offered again.
    expect(within(fields[1]!).queryByRole('option', { name: 'Status' })).toBeNull();
    fireEvent.change(fields[1]!, { target: { value: 'categoryId' } });
    fireEvent.change(within(panel).getAllByLabelText('Value')[1]!, { target: { value: CATEGORY } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(lastList()).toContain(`status=withdrawn&categoryId=${CATEGORY}`));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Status is Withdrawn')).toBeTruthy();
    expect(screen.getByText('Category is Meat')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (2)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status is Withdrawn' }));
    await waitFor(() => expect(lastList()).not.toContain('status='));
    expect(lastList()).toContain(`categoryId=${CATEGORY}`);
  });

  it('sorts by name, A to Z first, and by the other direction', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Name' }));
    await waitFor(() => expect(lastList()).toContain('sort=name&direction=asc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Z to A' }));
    await waitFor(() => expect(lastList()).toContain('sort=name&direction=desc'));
    expect(screen.getByText('Sorted by Name: Z to A')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Created' }));
    await waitFor(() => expect(lastList()).toContain('sort=created&direction=desc'));
  });

  it('keeps the column choice for this viewer in storage, in order', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Offers' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Last changed' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Move Last changed up' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['Product', 'Category', 'Status', 'Last changed', 'Offers']);
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:products-columns')!)).toEqual([
      'updated',
      'offers',
    ]);
    const body = screen.getAllByRole('row')[1]!;
    expect(within(body).getByText('6')).toBeTruthy();
    expect(within(body).getByText('29 Oct 2026')).toBeTruthy();
  });

  it('restores a saved choice on load, drops unknown ids, and resets to the default', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:products-columns',
      JSON.stringify(['seller', 'bogus', 'seller', 'scope']),
    );
    serve(() => page([row()]));
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    await waitFor(() =>
      expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
        'Product',
        'Category',
        'Status',
        'Seller',
        'Scope',
      ]),
    );
    expect(within(screen.getAllByRole('row')[1]!).getByText('Cedar Lane Halal Meats')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset to default' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  });

  it('still works when storage is missing or refuses', async () => {
    const get = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      serve(() => page([row()]));
      mount();
      await screen.findByText('Lamb cutlets 500 g');
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('checkbox', { name: 'Offers' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toContain('Offers');
    } finally {
      get.mockRestore();
    }
  });

  it('shows a PLATFORM product with the Platform seller and an unnamed one as such', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:products-columns',
      JSON.stringify(['seller', 'type']),
    );
    serve(() =>
      page([
        row({
          scope: 'PLATFORM',
          ownerSellerId: null,
          ownerStoreName: null,
          name: null,
          categoryName: null,
        }),
        row({ productId: '0190a000-0000-7000-8000-000000000003', ownerStoreName: null }),
      ]),
    );
    mount();
    await screen.findByText('Unnamed product');
    await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(5));
    expect(screen.getByText('No category')).toBeTruthy();
    expect(screen.getByText('Unnamed seller')).toBeTruthy();
    expect(screen.getAllByText('Platform').length).toBeGreaterThan(0);
  });

  it('pages with Previous and Next and shows the range', async () => {
    serve((url) =>
      url.includes('page=2')
        ? page([row({ name: 'Second page' })], { page: 2, total: 26 })
        : page([row()], { total: 26 }),
    );
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    expect(screen.getByText('1–1 of 26 products')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second page')).toBeTruthy();
    expect(lastList()).toContain('page=2');
    expect(screen.getByText('26–26 of 26 products')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows skeleton rows while loading, with the tabs and toolbar in place', () => {
    call.mockImplementation((_m, path) =>
      path === 'catalog/categories'
        ? Promise.resolve({ ok: true, status: 200, body: tree } as never)
        : new Promise(() => undefined),
    );
    mount();
    expect(screen.getByText('Loading products').closest('[role="status"]')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Product views' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search products' })).toBeTruthy();
  });

  it('shows the error banner with Try again, and the list after a retry', async () => {
    let fail = true;
    serve(() => (fail ? 'fail' : page([row()])));
    mount();
    expect(await screen.findByText('Products could not be loaded. Try again.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Lamb cutlets 500 g')).toBeTruthy();
    expect(screen.queryByText('Products could not be loaded. Try again.')).toBeNull();
  });

  it('says so, without a retry, when the API refuses the session', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText("You don't have access to products.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the empty state of a catalogue with no products, and of an empty tab', async () => {
    serve(() => page([], { counts: { active: 0, all: 0, inactive: 0 } }));
    mount();
    expect(await screen.findByText('No products yet')).toBeTruthy();
    cleanup();
    serve(() => page([], { counts: { active: 0, all: 5, inactive: 5 } }));
    mount();
    expect(await screen.findByText('No active products')).toBeTruthy();
  });

  it('shows "No products match" with Clear all after a search with no result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve((url) => (url.includes('q=zzz') ? page([], { total: 0 }) : page([row()])));
      mount();
      await screen.findByText('Lamb cutlets 500 g');
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
      await vi.advanceTimersByTimeAsync(400);
      expect(await screen.findByText('No products match')).toBeTruthy();
      expect(screen.getByText('0 products match')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[1]!);
      await vi.advanceTimersByTimeAsync(400);
      expect(await screen.findByText('Lamb cutlets 500 g')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a name sort over too many products with a message and no retry', async () => {
    call.mockImplementation((_m, path) =>
      path === 'catalog/categories'
        ? Promise.resolve({ ok: true, status: 200, body: tree } as never)
        : Promise.resolve({
            ok: false,
            failure: {
              status: 400,
              code: 'validation.failed',
              details: { fields: [{ path: 'sort', code: 'too-broad' }] },
            },
          }),
    );
    mount();
    expect(await screen.findByText(/Too many products to sort by name/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('product list helpers', () => {
  it('builds the query string with only what is set, trimmed', () => {
    expect(queryString({ ...DEFAULT_QUERY, q: '  lamb ', filters: { scope: 'PLATFORM' } })).toBe(
      'view=active&sort=updated&direction=desc&page=1&pageSize=25&q=lamb&scope=PLATFORM',
    );
  });

  it('cleans a saved column list', () => {
    expect(cleanColumns(undefined)).toEqual([]);
    expect(cleanColumns(['offers', 'x', 3, 'offers', 'created'])).toEqual(['offers', 'created']);
  });
});
