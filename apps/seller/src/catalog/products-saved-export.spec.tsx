// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast, Toaster } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// The address is the list's state, as in the list spec: a small store stands in for the router.
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
import type { ProductRow, ProductsPage } from './products-list-types.ts';
import type { SavedFilter, SavedFiltersAnswer } from './products-saved-types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const ID2 = '0190a000-0000-7000-8000-000000000002';
const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';
const MINE = '0190a000-0000-7000-8000-0000000000f1';
const SHARED = '0190a000-0000-7000-8000-0000000000f2';
const OTHERS = '0190a000-0000-7000-8000-0000000000f3';

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
const ROWS = [row(), row({ productId: ID2, productCode: 'P00000185', name: 'Basmati rice 5 kg' })];
let total: number;
let items: ProductRow[];
const pageOf = (): ProductsPage => ({
  items,
  total,
  page: 1,
  pageSize: 25,
  counts: { all: 143, drafts: 12, live: 100, inactive: 31, inReview: 4 },
});

const filter = (over: Partial<SavedFilter> & Pick<SavedFilter, 'id' | 'name'>): SavedFilter => ({
  listKey: 'seller.catalog.products',
  visibility: 'me',
  payload: {
    v: 1,
    view: 'live',
    q: 'oil',
    status: 'published',
    paused: false,
    sort: 'name',
    direction: 'asc',
  },
  ownedByMe: true,
  canManage: true,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-01T01:00:00.000Z',
  ...over,
});
const SAVED: SavedFilter[] = [
  filter({ id: MINE, name: 'Live oils' }),
  filter({
    id: SHARED,
    name: 'Needs review',
    visibility: 'everyone',
    payload: { v: 1, view: 'in-review', sort: 'updated', direction: 'desc', typeCode: 'grocery' },
  }),
  filter({
    id: OTHERS,
    name: 'Team picks',
    visibility: 'everyone',
    ownedByMe: false,
    canManage: false,
    payload: { v: 1, view: 'all', categoryId: CATEGORY, sort: 'created', direction: 'desc' },
  }),
];

type Reply = { ok: true; status: number; body: unknown } | { ok: false; failure: unknown };
let saved: SavedFilter[];
let canShare: boolean;
let savedFails: boolean;
let writes: { method: string; path: string; body: unknown; csrf: unknown }[];
let writeReply: (method: string, path: string, body: unknown) => Reply;

function serve() {
  call.mockImplementation(((method: string, path: string, body?: unknown, csrf?: unknown) => {
    if (path.startsWith('catalog/seller/saved-filters')) {
      if (method === 'GET') {
        const answer: SavedFiltersAnswer = {
          items: saved,
          canShare,
          limits: { perOwner: 50, shared: 20 },
        };
        return Promise.resolve(
          savedFails
            ? { ok: false, failure: { status: 503, code: 'access.unavailable' } }
            : { ok: true, status: 200, body: answer },
        );
      }
      writes.push({ method, path, body, csrf });
      return Promise.resolve(writeReply(method, path, body));
    }
    return Promise.resolve({ ok: true, status: 200, body: pageOf() });
  }) as never);
}
const listPaths = () =>
  call.mock.calls
    .map((entry) => entry[1])
    .filter((path) => path.startsWith('catalog/seller/products'));
// The one-off read of the whole store's size (the subtitle on a filtered address) is not a list read.
const lastList = () =>
  listPaths()
    .filter((path) => path !== 'catalog/seller/products?view=all&page=1')
    .at(-1)!;
const address = () => nav.state.search.toString();

const KEYS = ['catalog.own-product.view', 'catalog.own-product.edit'];

function mount(keys: readonly string[] = KEYS) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductsList
        accountId="acc-1"
        marketId="AU"
        timeZone="Australia/Brisbane"
        permissionKeys={keys}
        csrfToken="csrf-1"
        categories={[{ id: CATEGORY, name: 'Pantry', depth: 0 }]}
        productTypes={['grocery']}
        paging="pages"
      />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}

const tabs = () =>
  within(screen.getByRole('navigation', { name: 'Product views' }))
    .getAllByRole('button')
    .map((button) => button.textContent);
const rowBox = (name: string) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: `Select ${name}` });
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
  // @ts-expect-error jsdom has no matchMedia: the list then counts as desktop.
  delete window.matchMedia;
  vi.clearAllMocks();
  window.localStorage.clear();
  nav.state.search = new URLSearchParams();
  total = 143;
  items = ROWS;
  saved = SAVED;
  canShare = true;
  savedFails = false;
  writes = [];
  writeReply = () => ({ ok: true, status: 200, body: {} });
  serve();
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe('row selection and Bulk action', () => {
  it('keeps Bulk action disabled until a row is ticked and shows the count only in its menu', async () => {
    mount();
    await screen.findByText('Olive oil 1L');
    expect(menuButton().hasAttribute('disabled')).toBe(true);
    expect(menuButton().textContent).toBe('Bulk action');

    fireEvent.click(rowBox('Olive oil 1L'));
    expect(menuButton().hasAttribute('disabled')).toBe(false);
    // The count is in the open menu, never on the button.
    expect(menuButton().textContent).toBe('Bulk action');
    const menu = await openMenu();
    expect(within(menu).getByText('1 product selected')).toBeTruthy();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'ExportCSV or XLSX, with the columns shown',
      'Select all 143 products in this filter',
      'Clear selection',
    ]);
  });

  it('ticks the whole page from the header box, and clears it again', async () => {
    mount();
    await screen.findByText('Olive oil 1L');
    const all = screen.getAllByRole<HTMLInputElement>('checkbox', {
      name: 'Select all products on this page',
    })[0]!;
    fireEvent.click(all);
    expect(rowBox('Olive oil 1L').checked).toBe(true);
    expect(rowBox('Basmati rice 5 kg').checked).toBe(true);
    expect(within(await openMenu()).getByText('2 products selected')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(all);
    expect(rowBox('Olive oil 1L').checked).toBe(false);
    expect(menuButton().hasAttribute('disabled')).toBe(true);
  });

  it('selects every product of the filter from the menu and clears the selection', async () => {
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(rowBox('Olive oil 1L'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /^Select all 143/ }));
    expect(rowBox('Basmati rice 5 kg').checked).toBe(true);
    const menu = await openMenu();
    expect(within(menu).getByText('143 products selected')).toBeTruthy();
    // Everything is selected already: the link is gone.
    expect(within(menu).queryByRole('menuitem', { name: /^Select all/ })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Clear selection' }));
    expect(rowBox('Olive oil 1L').checked).toBe(false);
    expect(menuButton().hasAttribute('disabled')).toBe(true);
  });

  it('drops the selection when the search changes, not when the page does', async () => {
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(rowBox('Olive oil 1L'));
    nav.router.replace('/products?page=2');
    await waitFor(() => expect(lastList()).toContain('page=2'));
    expect(rowBox('Olive oil 1L').checked).toBe(true);
    nav.router.replace('/products?q=oil');
    await waitFor(() => expect(lastList()).toContain('q=oil'));
    await waitFor(() => expect(rowBox('Olive oil 1L').checked).toBe(false));
  });

  it('offers the boxes to a read-only member too: exporting needs only the view key', async () => {
    mount(['catalog.own-product.view']);
    await screen.findByText('Olive oil 1L');
    expect(screen.getByText('View only')).toBeTruthy();
    fireEvent.click(rowBox('Olive oil 1L'));
    expect(menuButton().hasAttribute('disabled')).toBe(false);
  });
});

describe('export', () => {
  const day = new Date().toISOString().slice(0, 10);
  const fetched: string[] = [];
  let saveNames: string[];
  let made: Blob[];
  function stubDownload(reply: () => Promise<Response>) {
    fetched.length = 0;
    saveNames = [];
    made = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return reply();
      }),
    );
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        made.push(blob);
        return 'blob:file';
      }),
      revokeObjectURL: vi.fn(),
    });
    return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saveNames.push(this.download);
    });
  }
  const fileOk = () =>
    Promise.resolve(new Response('Product,Status\r\nOlive oil 1L,Live\r\n', { status: 200 }));
  const params = (index = 0) => new URL(fetched[index]!, 'http://x').searchParams;
  const failWith = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  async function exportFromHeader(format?: 'xlsx') {
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export 143 products' });
    if (format === 'xlsx') fireEvent.click(within(dialog).getByRole('radio', { name: /^XLSX/ }));
    return dialog;
  }

  it('exports the whole filter from the header: the dialog asks the format and names the columns', async () => {
    nav.state.search = new URLSearchParams(
      `view=live&q=oil&status=published&categoryId=${CATEGORY}&paused=false&typeCode=grocery&sort=name&direction=asc&page=2&pageSize=50`,
    );
    total = 8;
    const click = stubDownload(fileOk);
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export 8 products' });
    expect(within(dialog).getByText('The file has the columns shown in the list.')).toBeTruthy();
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: /^CSV/ }).checked).toBe(
      true,
    );
    // Nothing is fetched until the format is confirmed.
    expect(fetched).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('8 products exported.')).toBeTruthy();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.startsWith('/api/catalog/seller/products/export?')).toBe(true);
    expect(Object.fromEntries(params())).toEqual({
      format: 'csv',
      columns: 'product,code,updated',
      sort: 'name',
      direction: 'asc',
      view: 'live',
      q: 'oil',
      status: 'published',
      categoryId: CATEGORY,
      paused: 'false',
      typeCode: 'grocery',
    });
    expect(saveNames).toEqual([`products-${day}.csv`]);
    expect(made[0]!.type).toBe('text/csv;charset=utf-8');
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('sends the columns as shown, and only the fixed one when none is chosen', async () => {
    window.localStorage.setItem(
      'mp:seller:AU:acc-1:products-columns',
      JSON.stringify(['offers', 'created']),
    );
    const click = stubDownload(fileOk);
    const dialog = await exportFromHeader();
    await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(6));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await screen.findByText('143 products exported.');
    expect(params().get('columns')).toBe('product,offers,created');
    click.mockRestore();
    cleanup();
    toast.dismiss();
    window.localStorage.setItem('mp:seller:AU:acc-1:products-columns', JSON.stringify([]));
    const again = stubDownload(fileOk);
    const second = await exportFromHeader();
    fireEvent.click(within(second).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetched).toHaveLength(1));
    expect(params().get('columns')).toBe('product');
    again.mockRestore();
  });

  it('exports the ticked rows as an XLSX workbook, by id and in the list order', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    const click = stubDownload(() => Promise.resolve(new Response(bytes, { status: 200 })));
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(rowBox('Olive oil 1L'));
    fireEvent.click(rowBox('Basmati rice 5 kg'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /^Export/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Export 2 products' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^XLSX/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('2 products exported.')).toBeTruthy();
    expect(Object.fromEntries(params())).toEqual({
      format: 'xlsx',
      columns: 'product,code,updated',
      sort: 'updated',
      direction: 'desc',
      productIds: `${ID},${ID2}`,
    });
    expect(saveNames).toEqual([`products-${day}.xlsx`]);
    expect(made[0]!.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(new Uint8Array(await made[0]!.arrayBuffer())).toEqual(bytes);
    // An export changes nothing: the selection stays.
    expect(rowBox('Olive oil 1L').checked).toBe(true);
    click.mockRestore();
  });

  it('exports the whole filter, not ids, after "Select all N products in this filter"', async () => {
    nav.state.search = new URLSearchParams('view=drafts&q=oil');
    total = 31;
    const click = stubDownload(fileOk);
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(rowBox('Olive oil 1L'));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /^Select all 31/ }));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: /^Export/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Export 31 products' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await screen.findByText('31 products exported.');
    expect(params().has('productIds')).toBe(false);
    expect(params().get('view')).toBe('drafts');
    expect(params().get('q')).toBe('oil');
    click.mockRestore();
  });

  it('says "Preparing your export…" while the file comes, with no notify-later promise', async () => {
    let release: (value: Response) => void = () => undefined;
    const click = stubDownload(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const dialog = await exportFromHeader();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('Preparing your export…')).toBeTruthy();
    // The buttons that start another export wait for this one.
    expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/notify/i)).toBeNull();
    release(new Response('Product\r\n', { status: 200 }));
    expect(await screen.findByText('143 products exported.')).toBeTruthy();
    expect(screen.queryByText(/notify/i)).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(false),
    );
    click.mockRestore();
  });

  it('closes the dialog without a request when it is cancelled', async () => {
    stubDownload(fileOk);
    const dialog = await exportFromHeader();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetched).toEqual([]);
  });

  it('has no header Export while the list is empty', async () => {
    total = 0;
    items = [];
    mount();
    await screen.findByText('No products');
    expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(true);
  });

  it.each([
    [
      '413 batch.too-large over the row cap: tell the seller to narrow the list',
      413,
      { code: 'batch.too-large', details: { max: 10000, total: 12500 } },
      'Too many products to export (12,500). Narrow the list to 10,000 or fewer, then try again.',
    ],
    [
      '413 batch.too-large over the id cap',
      413,
      { code: 'batch.too-large', details: { max: 100 } },
      'You can export up to 100 selected products at a time.',
    ],
    [
      '400 too-broad: a name sort over too many rows',
      400,
      {
        code: 'validation.failed',
        details: { fields: [{ path: 'sort', code: 'too-broad' }] },
      },
      'Too many products to put in order by name. Sort by Last changed or narrow the list, then try again.',
    ],
    [
      '400 any other validation problem',
      400,
      { code: 'validation.failed', details: { fields: [{ path: 'columns', code: 'value' }] } },
      'That export can’t be done. Reload the page and try again.',
    ],
    [
      '404 product.not-found: a selected row is gone',
      404,
      { code: 'product.not-found' },
      'Some of the selected products are no longer in your store. Reload the list and try again.',
    ],
    [
      '403 access.denied',
      403,
      { code: 'access.denied' },
      'You don’t have access to export products.',
    ],
    [
      '503 access.unavailable',
      503,
      { code: 'access.unavailable' },
      'The export didn’t work. Try again.',
    ],
  ])('shows the reason for %s', async (_name, status, body, text) => {
    const click = stubDownload(failWith(status, body));
    const dialog = await exportFromHeader();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(text)).toBeTruthy();
    // Nothing was saved, and Export can be tried again.
    expect(click).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(false),
    );
    click.mockRestore();
  });

  it('says so when the request itself fails, and when the answer is not JSON', async () => {
    const click = stubDownload(() => Promise.reject(new TypeError('network')));
    const dialog = await exportFromHeader();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('The export didn’t work. Try again.')).toBeTruthy();
    click.mockRestore();
    cleanup();
    toast.dismiss();
    const again = stubDownload(() => Promise.resolve(new Response('<html>', { status: 502 })));
    const second = await exportFromHeader();
    fireEvent.click(within(second).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('The export didn’t work. Try again.')).toBeTruthy();
    again.mockRestore();
  });
});

describe('saved filter tabs', () => {
  it('shows the saved filters after the built-in views, then Manage filters', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Live oils' })).toBeTruthy();
    expect(tabs()).toEqual([
      'All (143)',
      'Drafts (12)',
      'Live (100)',
      'Inactive (31)',
      'In review (4)',
      'Live oils',
      'Needs review',
      'Team picks',
    ]);
    expect(screen.getByRole('button', { name: 'Manage filters' })).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'GET',
      'catalog/seller/saved-filters?listKey=seller.catalog.products',
    );
  });

  it('opens a saved filter on the address without the version, keeping the page size', async () => {
    nav.state.search = new URLSearchParams('pageSize=50&page=3');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Live oils' }));
    await waitFor(() =>
      expect(address()).toBe('view=live&q=oil&status=published&paused=false&sort=name&pageSize=50'),
    );
    expect(address()).not.toContain('v=');
    await waitFor(() =>
      expect(lastList()).toBe(
        'catalog/seller/products?view=live&sort=name&direction=asc&page=1&pageSize=50&q=oil&status=published&paused=false',
      ),
    );
    expect(screen.getByRole('button', { name: 'Live oils' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('oil');
    // The saved filter is the tab on show, so Save filter is not offered again.
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
  });

  it('applies the conditions of another saved filter (type, category) and marks it', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Needs review' }));
    await waitFor(() => expect(address()).toBe('view=in-review&typeCode=grocery'));
    fireEvent.click(screen.getByRole('button', { name: 'Team picks' }));
    await waitFor(() => expect(address()).toBe(`categoryId=${CATEGORY}&sort=created`));
    expect(screen.getByRole('button', { name: 'Team picks' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('leaves the saved tab when the list changes, and returns to a built-in view on its own', async () => {
    nav.state.search = new URLSearchParams(
      'view=live&q=oil&status=published&paused=false&sort=name&direction=asc',
    );
    mount();
    await screen.findByText('Olive oil 1L');
    expect(
      (await screen.findByRole('button', { name: 'Live oils' })).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Drafts (12)' }));
    await waitFor(() => expect(address()).toContain('view=drafts'));
    expect(screen.getByRole('button', { name: 'Live oils' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('keeps the built-in tabs only, with no Manage or Save, when the saved filters cannot load', async () => {
    savedFails = true;
    nav.state.search = new URLSearchParams('q=beef');
    mount();
    await screen.findByText('Olive oil 1L');
    expect(tabs()).toEqual([
      'All (143)',
      'Drafts (12)',
      'Live (100)',
      'Inactive (31)',
      'In review (4)',
    ]);
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
  });

  it('offers Save filter only when the list differs from every view', async () => {
    mount();
    await screen.findByText('Olive oil 1L');
    await screen.findByRole('button', { name: 'Live oils' });
    // A built-in view as it is: nothing to save.
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Live (100)' }));
    await waitFor(() => expect(address()).toBe('view=live'));
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    // A search makes it a list of its own.
    nav.router.replace('/products?view=live&q=beef');
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
    // Another sort of a plain view does too, without chips or "match" text.
    nav.router.replace('/products?sort=name');
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    // The list of a saved filter is that tab.
    nav.router.replace('/products?view=in-review&typeCode=grocery');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull());
  });
});

describe('Save filter', () => {
  async function openSave() {
    nav.state.search = new URLSearchParams(
      `view=live&q=beef&status=published&categoryId=${CATEGORY}&paused=true&typeCode=grocery&sort=created&direction=asc&page=4&pageSize=50`,
    );
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    return screen.findByRole('dialog', { name: 'Save this filter' });
  }

  it('summarises the list, lets a member who can share choose, and posts the flat document', async () => {
    writeReply = () => ({
      ok: true,
      status: 201,
      body: filter({ id: MINE, name: 'Beef', visibility: 'everyone' }),
    });
    const dialog = await openSave();
    expect(
      within(dialog).getByText(
        'Live · Search “beef” · Status is Published · Category is Pantry · Paused is Yes · Product type is grocery · Sorted by Created, Oldest first',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /Only me/ })).toBeTruthy();
    expect(
      within(dialog).getByText('Everyone: everyone in your store gets it as a tab.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Beef ' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Everyone/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: 'catalog/seller/saved-filters',
      csrf: 'csrf-1',
      body: {
        listKey: 'seller.catalog.products',
        name: 'Beef',
        visibility: 'everyone',
        // Flat, with the version; the page number and size are not part of a filter.
        payload: {
          v: 1,
          view: 'live',
          q: 'beef',
          status: 'published',
          categoryId: CATEGORY,
          paused: true,
          typeCode: 'grocery',
          sort: 'created',
          direction: 'asc',
        },
      },
    });
    expect(await screen.findByText('Saved “Beef”')).toBeTruthy();
    // The tabs are read again.
    await waitFor(() =>
      expect(
        call.mock.calls.filter((entry) => entry[0] === 'GET' && entry[1].includes('saved-filters'))
          .length,
      ).toBe(2),
    );
  });

  it('tells a role that cannot share the filter is saved for them only, and sends me', async () => {
    canShare = false;
    writeReply = () => ({ ok: true, status: 201, body: filter({ id: MINE, name: 'Mine' }) });
    const dialog = await openSave();
    expect(
      within(dialog).getByText('Saved for you only. Your role can’t share filters.'),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((writes[0]?.body as { visibility: string }).visibility).toBe('me');
  });

  it('keeps a search-only filter small: only the keys the list has set', async () => {
    nav.state.search = new URLSearchParams('q=beef');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Beef' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((writes[0]?.body as { payload: unknown }).payload).toEqual({
      v: 1,
      view: 'all',
      q: 'beef',
      sort: 'updated',
      direction: 'desc',
    });
  });

  it('asks for a name, and says under the field when the name is taken', async () => {
    writeReply = () => ({ ok: false, failure: { status: 409, code: 'saved-filter.name-taken' } });
    const dialog = await openSave();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    expect(await within(dialog).findByText('Enter a name for the filter.')).toBeTruthy();
    expect(writes).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Live oils' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    expect(
      await within(dialog).findByText(
        'A filter with this name already exists. Choose another name.',
      ),
    ).toBeTruthy();
  });

  it.each([
    [
      409,
      'saved-filter.limit-reached',
      'You can keep up to 50 saved filters. Delete one to save another.',
    ],
    [
      409,
      'saved-filter.shared-limit-reached',
      'Up to 20 filters can be shared with everyone in your store. Delete or unshare one first.',
    ],
    [403, 'access.denied', 'Your role can’t do this.'],
    [
      403,
      'access.acting-as-refused',
      'Filters can’t be changed while you are signed in as this seller.',
    ],
    [503, 'access.unavailable', 'The filter could not be saved. Try again.'],
  ])('says a %s %s refusal in a banner and keeps the dialog open', async (status, code, text) => {
    writeReply = () => ({ ok: false, failure: { status, code } });
    const dialog = await openSave();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Beef' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Save this filter' })).toBeTruthy();
  });
});

describe('Manage filters', () => {
  async function openManage() {
    mount();
    await screen.findByText('Olive oil 1L');
    fireEvent.click(await screen.findByRole('button', { name: 'Manage filters' }));
    return screen.findByRole('dialog', { name: 'Manage filters' });
  }
  const putOk = (body: Partial<SavedFilter> & Pick<SavedFilter, 'id' | 'name'>): Reply => ({
    ok: true,
    status: 200,
    body: filter(body),
  });

  it('lists every filter, with actions only on the ones this member may manage', async () => {
    const dialog = await openManage();
    expect(
      within(dialog).getByText('Rename, change who can use a filter, or delete it.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Edit Live oils' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Delete Needs review' })).toBeTruthy();
    expect(within(dialog).getByText('Team picks')).toBeTruthy();
    expect(within(dialog).getByText('Shared by a team member')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Edit Team picks' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete Team picks' })).toBeNull();
  });

  it('renames a filter and shares it with everyone in the store', async () => {
    writeReply = () => putOk({ id: MINE, name: 'Oils', visibility: 'everyone' });
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Live oils' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Oils ' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Everyone/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PUT',
      path: `catalog/seller/saved-filters/${MINE}`,
      csrf: 'csrf-1',
      body: { name: 'Oils', visibility: 'everyone' },
    });
    expect(await screen.findByText('Updated “Oils”')).toBeTruthy();
  });

  it('unshares a shared filter', async () => {
    writeReply = () => putOk({ id: SHARED, name: 'Needs review', visibility: 'me' });
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Needs review' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Only me/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ name: 'Needs review', visibility: 'me' });
  });

  it('does not offer Everyone to a role that cannot share, but lets it unshare one', async () => {
    canShare = false;
    const dialog = await openManage();
    expect(
      within(dialog).getByText('Rename or delete your filters. Your role can’t share filters.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Live oils' }));
    // A private filter has nothing to choose: the role's limit is said instead.
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(
      within(dialog).getByText('Saved for you only. Your role can’t share filters.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Needs review' }));
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: /Only me/ }).disabled).toBe(
      false,
    );
  });

  it.each([
    [
      409,
      'saved-filter.name-taken',
      'A filter with this name already exists. Choose another name.',
    ],
    [
      409,
      'saved-filter.shared-limit-reached',
      'Up to 20 filters can be shared with everyone in your store. Delete or unshare one first.',
    ],
    [403, 'access.denied', 'Your role can’t do this.'],
    [
      403,
      'access.acting-as-refused',
      'Filters can’t be changed while you are signed in as this seller.',
    ],
    [404, 'saved-filter.not-found', 'This filter is no longer there. The list has been refreshed.'],
    [503, 'access.unavailable', 'The filter could not be saved. Try again.'],
  ])('says a %s %s refusal of a rename', async (status, code, text) => {
    writeReply = () => ({ ok: false, failure: { status, code } });
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Live oils' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Other' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findAllByText(text)).not.toHaveLength(0);
    if (code === 'saved-filter.not-found') {
      // The tabs are read again, so a filter that is gone leaves them.
      await waitFor(() =>
        expect(
          call.mock.calls.filter(
            (entry) => entry[0] === 'GET' && entry[1].includes('saved-filters'),
          ),
        ).toHaveLength(2),
      );
    }
  });

  it('asks once before deleting, then removes the filter and reads the tabs again', async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Live oils' }));
    const ask = within(dialog).getByRole('group', { name: 'Delete Live oils' });
    expect(within(ask).getByText('Delete “Live oils”? It is removed from your tabs.')).toBeTruthy();
    expect(writes).toHaveLength(0);
    saved = SAVED.filter((item) => item.id !== MINE);
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete filter' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'DELETE',
      path: `catalog/seller/saved-filters/${MINE}`,
      body: undefined,
      csrf: 'csrf-1',
    });
    expect(await screen.findByText('Deleted “Live oils”')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Live oils' })).toBeNull());
  });

  it('warns that deleting a shared filter removes it for the whole store', async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Needs review' }));
    expect(
      within(dialog).getByText(
        'Delete “Needs review”? It is removed from the tabs of everyone in your store.',
      ),
    ).toBeTruthy();
  });

  it('treats a filter that is already gone as deleted', async () => {
    writeReply = () => ({
      ok: false,
      failure: { status: 404, code: 'saved-filter.not-found' },
    });
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Live oils' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete filter' }));
    expect(await screen.findByText('Deleted “Live oils”')).toBeTruthy();
  });

  it.each([
    [403, 'access.denied', 'Your role can’t do this.'],
    [
      403,
      'access.acting-as-refused',
      'Filters can’t be changed while you are signed in as this seller.',
    ],
    [503, 'access.unavailable', 'The filter could not be saved. Try again.'],
  ])('says a %s %s refusal of a delete and keeps the question open', async (status, code, text) => {
    writeReply = () => ({ ok: false, failure: { status, code } });
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Live oils' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete filter' }));
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(within(dialog).getByRole('group', { name: 'Delete Live oils' })).toBeTruthy();
  });

  it('says there are no saved filters yet', async () => {
    saved = [];
    const dialog = await openManage();
    expect(within(dialog).getByText('No saved filters yet')).toBeTruthy();
  });
});
