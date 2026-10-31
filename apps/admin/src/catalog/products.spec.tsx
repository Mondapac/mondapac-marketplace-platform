// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { toast, Toaster } from '@mondapac/ui';
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

/** No saved views: the answer of the saved filters route in the tests of the list itself. */
const NO_SAVED = {
  items: [],
  canShare: false,
  limits: { perOwner: 50, shared: 20 },
};

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => ProductsPage | 'fail' | 'denied') {
  call.mockImplementation((_method, path) => {
    if (path === 'catalog/categories') {
      return Promise.resolve({ ok: true, status: 200, body: tree } as never);
    }
    if (path.startsWith('catalog/admin/saved-filters')) {
      return Promise.resolve({ ok: true, status: 200, body: NO_SAVED } as never);
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
  call.mock.calls
    .map((entry) => entry[1])
    .filter((path) => path.startsWith('catalog/admin') && !path.includes('saved-filters'));
const lastList = () => listCalls()[listCalls().length - 1]!;

const ALL_KEYS = [
  'catalog.product.view',
  'catalog.product.pause',
  'catalog.product.delete',
  'catalog.platform-product.retire',
];

function mount(
  permissionKeys: readonly string[] = ALL_KEYS,
  market: { readonly id: string; readonly name: string } = { id: 'AU', name: 'Australia' },
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductsList
        accountId="acc-1"
        marketId={market.id}
        marketName={market.name}
        timeZone="Australia/Brisbane"
        permissionKeys={permissionKeys}
        csrfToken="csrf-1"
      />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}

describe('admin product list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    toast.dismiss();
  });

  it('names the Market by its display name, not its code (second fixture ZZ)', async () => {
    serve(() => page([row()]));
    mount(ALL_KEYS, { id: 'ZZ', name: 'Zedland' });
    expect(await screen.findByText('1,284 products in the Zedland market')).toBeTruthy();
    expect(screen.queryByText(/ZZ market/)).toBeNull();
  });

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
    // No "Products" heading over the tabs (the topbar names the page); the header holds the Bulk
    // action button and the count of the Market's products, and no Import or Add product.
    expect(screen.queryByRole('heading', { name: 'Products' })).toBeNull();
    expect(screen.getByText('1,284 products in the Australia market')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bulk action' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage filters' })).toBeTruthy();
    for (const absent of ['Import', 'Add product']) {
      expect(screen.queryByText(absent)).toBeNull();
    }
  });

  it('shows the four fixed columns by default: product with code, category, status', async () => {
    serve(() => page([row()]));
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    // The first header is the select-all box: it has no text.
    expect(headers).toEqual(['', 'Product', 'Category', 'Status']);
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
    expect(headers).toEqual(['', 'Product', 'Category', 'Status', 'Last changed', 'Offers']);
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
        '',
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
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
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
    await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(6));
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

describe('admin product bulk action', () => {
  const ID2 = '0190a000-0000-7000-8000-000000000002';
  const rows = () => [row(), row({ productId: ID2, name: 'Beef mince', productCode: 'AU-000185' })];
  const answer = (
    counts: { done: number; skipped: number; failed: number },
    extra: Record<string, unknown> = {},
  ) => ({
    action: 'pause',
    dryRun: false,
    requested: 2,
    eligible: counts.done,
    confirmOfferCount: 0,
    affectedOfferCount: 0,
    counts,
    results: [],
    ...extra,
  });
  type Posted = { path: string; body: Record<string, unknown>; csrf: unknown };
  let posted: Posted[];

  /** The list answers by URL; a POST to the bulk route answers what `reply` says. */
  function serveBulk(
    reply: (body: Record<string, unknown>) => unknown,
    list: () => ProductsPage = () => page(rows(), { total: 26 }),
  ) {
    call.mockImplementation(((method: string, path: string, body?: unknown, csrf?: unknown) => {
      if (path === 'catalog/categories') {
        return Promise.resolve({ ok: true, status: 200, body: tree });
      }
      if (path.startsWith('catalog/admin/saved-filters')) {
        return Promise.resolve({ ok: true, status: 200, body: NO_SAVED });
      }
      if (method === 'POST') {
        posted.push({ path, body: body as Record<string, unknown>, csrf });
        const result = reply(body as Record<string, unknown>);
        if (result !== null && typeof result === 'object' && 'failure' in result) {
          return Promise.resolve({ ok: false, ...result });
        }
        return Promise.resolve({ ok: true, status: 200, body: result });
      }
      return Promise.resolve({ ok: true, status: 200, body: list() });
    }) as never);
  }
  const rowBox = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` });
  const menuButton = () => screen.getByRole('button', { name: 'Bulk action' });
  const openMenu = async () => {
    fireEvent.click(menuButton());
    return screen.findByRole('menu', { name: 'Bulk action' });
  };

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    vi.clearAllMocks();
    window.localStorage.clear();
    posted = [];
  });
  afterEach(() => {
    cleanup();
    toast.dismiss();
  });

  it('keeps Bulk action disabled until a row is selected, and shows the count only in the open menu', async () => {
    serveBulk(() => answer({ done: 0, skipped: 0, failed: 0 }));
    mount();
    await screen.findByText('Beef mince');
    expect(menuButton().hasAttribute('disabled')).toBe(true);

    fireEvent.click(rowBox('Lamb cutlets 500 g'));
    fireEvent.click(rowBox('Beef mince'));

    expect(menuButton().hasAttribute('disabled')).toBe(false);
    expect(menuButton().textContent).toBe('Bulk action');
    // No floating bar and no count outside the menu.
    expect(screen.queryByText(/selected/)).toBeNull();
    const menu = await openMenu();
    expect(within(menu).getByText('2 products selected')).toBeTruthy();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Activate',
      'Deactivate',
      'ExportCSV, with the columns shown',
      'Delete…',
      'Select all 26 products in this filter',
      'Clear selection',
    ]);
  });

  it('ticks the whole page with the header box, and shows a dash when only some rows are ticked', async () => {
    serveBulk(() => answer({ done: 0, skipped: 0, failed: 0 }));
    mount();
    await screen.findByText('Beef mince');
    const header = screen.getByRole('checkbox', { name: 'Select all products on this page' });

    fireEvent.click(rowBox('Beef mince'));
    expect((header as HTMLInputElement).indeterminate).toBe(true);
    expect((header as HTMLInputElement).checked).toBe(false);

    fireEvent.click(header);
    expect((rowBox('Lamb cutlets 500 g') as HTMLInputElement).checked).toBe(true);
    expect((rowBox('Beef mince') as HTMLInputElement).checked).toBe(true);
    expect((header as HTMLInputElement).checked).toBe(true);
    expect((header as HTMLInputElement).indeterminate).toBe(false);

    fireEvent.click(header);
    expect((rowBox('Beef mince') as HTMLInputElement).checked).toBe(false);
    expect(menuButton().hasAttribute('disabled')).toBe(true);
  });

  it('clears the selection with Clear selection and when the tab changes', async () => {
    serveBulk(() => answer({ done: 0, skipped: 0, failed: 0 }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Clear selection' }));
    expect((rowBox('Beef mince') as HTMLInputElement).checked).toBe(false);
    expect(menuButton().hasAttribute('disabled')).toBe(true);

    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    await waitFor(() => expect(lastList()).toContain('view=all'));
    await waitFor(() => expect(menuButton().hasAttribute('disabled')).toBe(true));
  });

  it('Deactivate asks first, then posts the ticked ids with the CSRF token, and toasts the counts', async () => {
    serveBulk(() =>
      answer(
        { done: 1, skipped: 1, failed: 0 },
        {
          results: [
            { productId: ID, outcome: 'done' },
            { productId: ID2, outcome: 'skipped', reason: 'product.already-paused' },
          ],
        },
      ),
    );
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Lamb cutlets 500 g'));
    fireEvent.click(rowBox('Beef mince'));

    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate 2 products?' });
    expect(within(dialog).getByText(/Customers stop seeing them/)).toBeTruthy();
    expect(posted).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    expect(
      await screen.findByText('1 product deactivated. 1 skipped: 1 already inactive.'),
    ).toBeTruthy();
    expect(posted).toEqual([
      {
        path: 'catalog/admin/products/bulk',
        body: { action: 'pause', productIds: [ID, ID2] },
        csrf: 'csrf-1',
      },
    ]);
    // The list loads again and the selection is gone.
    await waitFor(() => expect(menuButton().hasAttribute('disabled')).toBe(true));
    expect(listCalls().length).toBeGreaterThan(1);
  });

  it('Cancel in the Deactivate dialog changes nothing', async () => {
    serveBulk(() => answer({ done: 1, skipped: 0, failed: 0 }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate 1 product?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posted).toEqual([]);
    expect((rowBox('Beef mince') as HTMLInputElement).checked).toBe(true);
  });

  it('Activate runs at once, without a dialog', async () => {
    serveBulk(() => answer({ done: 2, skipped: 0, failed: 0 }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Lamb cutlets 500 g'));
    fireEvent.click(rowBox('Beef mince'));

    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Activate' }));

    expect(await screen.findByText('2 products activated.')).toBeTruthy();
    expect(posted[0]?.body).toEqual({ action: 'resume', productIds: [ID, ID2] });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so in a warning when nothing changed, and as an error when some products failed', async () => {
    serveBulk(() => answer({ done: 0, skipped: 2, failed: 0 }, { results: [] }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Activate' }));
    expect(await screen.findByText('2 skipped.')).toBeTruthy();
    toast.dismiss();
    cleanup();

    serveBulk(() => answer({ done: 1, skipped: 0, failed: 1 }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Activate' }));
    expect(
      await screen.findByText('1 product activated. 1 could not be changed. Try again.'),
    ).toBeTruthy();
  });

  it('groups the skip reasons with their counts, and never shows empty parentheses', async () => {
    serveBulk(() =>
      answer(
        { done: 0, skipped: 2, failed: 0 },
        {
          results: [
            { productId: ID, outcome: 'skipped', reason: 'product.already-paused' },
            { productId: ID2, outcome: 'skipped', reason: 'product.not-published' },
          ],
        },
      ),
    );
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Activate' }));
    expect(await screen.findByText('2 skipped: 1 already inactive, 1 not active.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('()');
  });

  it('Delete shows how many Offers end from a dry run, then confirms with that number', async () => {
    serveBulk((body) =>
      body['dryRun'] === true
        ? answer(
            { done: 0, skipped: 0, failed: 0 },
            { dryRun: true, eligible: 2, confirmOfferCount: 12, affectedOfferCount: 18 },
          )
        : answer({ done: 2, skipped: 0, failed: 0 }),
    );
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Lamb cutlets 500 g'));
    fireEvent.click(rowBox('Beef mince'));

    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Delete…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 products?' });
    expect(
      await within(dialog).findByText(
        'They are removed from the catalog for customers and sellers, and the 18 offers on them end. Order history keeps them. You can’t undo this.',
      ),
    ).toBeTruthy();
    // The safe choice has focus.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posted).toEqual([
      {
        path: 'catalog/admin/products/bulk',
        body: { action: 'delete', productIds: [ID, ID2], dryRun: true },
        csrf: 'csrf-1',
      },
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete products' }));

    expect(await screen.findByText('2 products deleted.')).toBeTruthy();
    expect(posted[1]?.body).toEqual({
      action: 'delete',
      productIds: [ID, ID2],
      confirmOfferCount: 12,
    });
  });

  it('shows the new Offer count when it moved before the confirmation, to confirm again', async () => {
    let count = 12;
    serveBulk((body) => {
      if (body['dryRun'] === true) {
        return answer(
          { done: 0, skipped: 0, failed: 0 },
          { dryRun: true, eligible: 1, confirmOfferCount: count, affectedOfferCount: count },
        );
      }
      count = 14;
      return {
        failure: {
          status: 409,
          code: 'retire.count-changed',
          details: { currentCount: 14 },
        },
      };
    });
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 product?' });
    await within(dialog).findByText(/the 12 offers on them end/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete products' }));

    expect(
      await screen.findByText('The number of offers changed to 14. Check it and confirm again.'),
    ).toBeTruthy();
    expect(await within(dialog).findByText(/the 14 offers on them end/)).toBeTruthy();
  });

  it('Select all N in this filter sends the tab and filters as a selector, not the ids', async () => {
    serveBulk(() => answer({ done: 26, skipped: 0, failed: 0 }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(
      within(await openMenu()).getByRole('menuitem', {
        name: 'Select all 26 products in this filter',
      }),
    );

    // Every row shows ticked, and the menu counts the whole filter and no longer offers the link.
    expect((rowBox('Lamb cutlets 500 g') as HTMLInputElement).checked).toBe(true);
    const menu = await openMenu();
    expect(within(menu).getByText('26 products selected')).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: /Select all/ })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Activate' }));

    expect(await screen.findByText('26 products activated.')).toBeTruthy();
    expect(posted[0]?.body).toEqual({ action: 'resume', selector: { view: 'active' } });
  });

  it('unticking one row leaves "all in this filter" and keeps the other rows of the page', async () => {
    serveBulk(() => answer({ done: 0, skipped: 0, failed: 0 }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(
      within(await openMenu()).getByRole('menuitem', {
        name: 'Select all 26 products in this filter',
      }),
    );

    fireEvent.click(rowBox('Beef mince'));

    expect((rowBox('Beef mince') as HTMLInputElement).checked).toBe(false);
    expect((rowBox('Lamb cutlets 500 g') as HTMLInputElement).checked).toBe(true);
    expect(within(await openMenu()).getByText('1 product selected')).toBeTruthy();
  });

  it('refuses a filter over the cap with a message that says how to narrow it', async () => {
    serveBulk(() => ({
      failure: {
        status: 413,
        code: 'batch.too-large',
        details: { max: 2000, total: 2500 },
      },
    }));
    mount();
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    fireEvent.click(
      within(await openMenu()).getByRole('menuitem', {
        name: 'Select all 26 products in this filter',
      }),
    );
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Activate' }));

    expect(
      await screen.findByText('Too many products (2,500). Narrow the filter to 2,000 or fewer.'),
    ).toBeTruthy();
  });

  it('exports the ticked rows with the columns shown, as a CSV download', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:products-columns',
      JSON.stringify(['offers', 'updated']),
    );
    serveBulk(() => answer({ done: 0, skipped: 0, failed: 0 }));
    const fetched: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      fetched.push(url);
      return Promise.resolve(
        new Response('﻿Product,Status\r\nBeef mince,Active\r\nLamb,Active\r\n', { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.fn(() => 'blob:csv');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      mount();
      await screen.findByText('Beef mince');
      await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(6));
      fireEvent.click(rowBox('Lamb cutlets 500 g'));
      fireEvent.click(rowBox('Beef mince'));

      fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /^Export/ }));

      expect(await screen.findByText('2 products exported.')).toBeTruthy();
      expect(fetched).toEqual([
        `/api/catalog/admin/products/export?format=csv&columns=offers%2Cupdated&ids=${ID}%2C${ID2}`,
      ]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:csv');
      // An export changes nothing: no POST and the selection stays.
      expect(posted).toEqual([]);
      expect((rowBox('Beef mince') as HTMLInputElement).checked).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      click.mockRestore();
    }
  });

  it('says so when the export fails', async () => {
    serveBulk(() => answer({ done: 0, skipped: 0, failed: 0 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"code":"access.unavailable"}', { status: 503 }))),
    );
    try {
      mount();
      await screen.findByText('Beef mince');
      fireEvent.click(rowBox('Beef mince'));
      fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /^Export/ }));
      expect(await screen.findByText('That didn’t work. Try again.')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers only Export to an admin who may view but not pause or delete', async () => {
    serveBulk(() => answer({ done: 0, skipped: 0, failed: 0 }));
    mount(['catalog.product.view']);
    await screen.findByText('Beef mince');
    fireEvent.click(rowBox('Beef mince'));
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'ExportCSV, with the columns shown',
      'Select all 26 products in this filter',
      'Clear selection',
    ]);
  });

  it('shows a paused product as Inactive, in the Inactive tab and the status filter', async () => {
    serveBulk(
      () => answer({ done: 0, skipped: 0, failed: 0 }),
      () => page([row({ status: 'paused' })]),
    );
    mount();
    expect(await screen.findByText('Inactive', { selector: 'span' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'status' } });
    expect(
      within(within(panel).getByLabelText('Value')).getByRole('option', { name: 'Inactive' }),
    ).toBeTruthy();
  });

  it('stops ticking single rows at the cap of one request', async () => {
    const many = Array.from({ length: 201 }, (_, index) =>
      row({
        productId: `0190a000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
        name: `Product ${index}`,
        productCode: `AU-${index}`,
      }),
    );
    serveBulk(
      () => answer({ done: 0, skipped: 0, failed: 0 }),
      () => page(many, { total: 400 }),
    );
    mount();
    await screen.findByText('Product 0');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all products on this page' }));
    expect((rowBox('Product 199') as HTMLInputElement).checked).toBe(true);
    expect((rowBox('Product 200') as HTMLInputElement).checked).toBe(false);
    expect((rowBox('Product 200') as HTMLInputElement).disabled).toBe(true);
    expect(within(await openMenu()).getByText('200 products selected')).toBeTruthy();
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
