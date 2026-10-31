// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { toast, Toaster } from '@mondapac/ui';
import { ProductsList } from './products-list.tsx';
import type { SavedFilter, SavedFiltersAnswer } from './products-saved-types.ts';
import type { ProductRow, ProductsPage } from './products-types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const MINE = '0190a000-0000-7000-8000-0000000000f1';
const SHARED = '0190a000-0000-7000-8000-0000000000f2';
const OTHERS = '0190a000-0000-7000-8000-0000000000f3';

const row = (over: Partial<ProductRow> = {}): ProductRow => ({
  productId: ID,
  productCode: 'AU-000184',
  name: 'Lamb cutlets 500 g',
  primaryImageId: null,
  scope: 'SELLER',
  ownerSellerId: '0190a000-0000-7000-8000-0000000000b1',
  ownerStoreName: 'Cedar Lane Halal Meats',
  categoryId: null,
  categoryName: null,
  typeCode: 'simple',
  status: 'published',
  offerCount: 6,
  updatedAt: '2026-10-29T01:00:00.000Z',
  createdAt: '2026-10-01T01:00:00.000Z',
  ...over,
});
const page = (total = 1): ProductsPage => ({
  items: [row()],
  total,
  page: 1,
  pageSize: 25,
  counts: { active: 1148, all: 1284, inactive: 136 },
});

const filter = (over: Partial<SavedFilter> & Pick<SavedFilter, 'id' | 'name'>): SavedFilter => ({
  listKey: 'admin.catalog.products',
  visibility: 'me',
  payload: {
    v: 1,
    view: 'all',
    q: 'lamb',
    filters: { status: 'paused' },
    sort: 'name',
    direction: 'asc',
  },
  ownedByMe: true,
  canManage: true,
  count: 12,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-01T01:00:00.000Z',
  ...over,
});

const SAVED: SavedFilter[] = [
  filter({ id: MINE, name: 'Paused lamb' }),
  filter({
    id: SHARED,
    name: 'Needs review',
    visibility: 'everyone',
    payload: { v: 1, view: 'inactive', filters: {}, sort: 'updated', direction: 'desc' },
    count: 136,
  }),
  filter({
    id: OTHERS,
    name: 'Team picks',
    visibility: 'everyone',
    ownedByMe: false,
    canManage: false,
    count: null,
    payload: {
      v: 1,
      view: 'active',
      filters: { scope: 'PLATFORM' },
      sort: 'name',
      direction: 'asc',
    },
  }),
];

type Reply = { ok: true; status: number; body: unknown } | { ok: false; failure: unknown };
let saved: SavedFilter[];
let canShare: boolean;
let savedFails: boolean;
let writes: { method: string; path: string; body: unknown; csrf: unknown }[];
let writeReply: (method: string, path: string, body: unknown) => Reply;

function answer(): SavedFiltersAnswer {
  return { items: saved, canShare, limits: { perOwner: 50, shared: 20 } };
}

function serve() {
  call.mockImplementation(((method: string, path: string, body?: unknown, csrf?: unknown) => {
    if (path === 'catalog/categories') {
      return Promise.resolve({ ok: true, status: 200, body: { categories: [] } });
    }
    if (path.startsWith('catalog/admin/saved-filters')) {
      if (method === 'GET') {
        return Promise.resolve(
          savedFails
            ? { ok: false, failure: { status: 503, code: 'access.unavailable' } }
            : { ok: true, status: 200, body: answer() },
        );
      }
      writes.push({ method, path, body, csrf });
      return Promise.resolve(writeReply(method, path, body));
    }
    const total = path.includes('q=lamb') ? 12 : 1284;
    return Promise.resolve({ ok: true, status: 200, body: page(total) });
  }) as never);
}
const productCalls = () =>
  call.mock.calls
    .map((entry) => entry[1])
    .filter((path) => path.startsWith('catalog/admin/products'));

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductsList
        accountId="acc-1"
        marketId="AU"
        timeZone="Australia/Brisbane"
        permissionKeys={['catalog.product.view']}
        csrfToken="csrf-1"
      />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}

describe('saved views of the product list', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    vi.clearAllMocks();
    window.localStorage.clear();
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
  });

  it('shows the saved views after the fixed tabs, with counts where the API gave one', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Paused lamb (12)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Needs review (136)' })).toBeTruthy();
    // A view without a count is a tab without one.
    expect(screen.getByRole('button', { name: 'Team picks' })).toBeTruthy();
    const names = within(screen.getByRole('navigation', { name: 'Product views' }))
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.slice(0, 3)).toEqual(['Active (1,148)', 'All (1,284)', 'Inactive (136)']);
    expect(names.slice(3)).toEqual(['Paused lamb (12)', 'Needs review (136)', 'Team picks']);
    expect(screen.getByRole('button', { name: 'Manage filters' })).toBeTruthy();
  });

  it('applies the saved view when its tab is picked and leaves it when the page changes', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Paused lamb (12)' }));
    await waitFor(() =>
      expect(productCalls().at(-1)).toBe(
        'catalog/admin/products?view=all&sort=name&direction=asc&page=1&pageSize=25&q=lamb&status=paused',
      ),
    );
    expect(screen.getByRole('button', { name: /^Paused lamb/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('lamb');
    // The shown count is the live total of the list.
    expect(await screen.findByRole('button', { name: 'Paused lamb (12)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Inactive (136)' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Paused lamb (12)' }).getAttribute('aria-pressed'),
      ).toBe('false'),
    );
    expect(
      screen.getByRole('button', { name: 'Inactive (136)' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('keeps the three fixed tabs and offers no saved views when they cannot load', async () => {
    savedFails = true;
    mount();
    expect(await screen.findByText('Lamb cutlets 500 g')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Active (1,148)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });

  it('offers Save filter only while the list is filtered', async () => {
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'beef' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
  });

  async function openSave() {
    mount();
    await screen.findByText('Lamb cutlets 500 g');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'beef' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    return screen.findByRole('dialog', { name: 'Save this filter' });
  }

  it('lets an admin who can share choose Only me or Everyone, and saves the current view', async () => {
    writeReply = () => ({
      ok: true,
      status: 201,
      body: filter({
        id: '0190a000-0000-7000-8000-0000000000f9',
        name: 'Beef',
        visibility: 'everyone',
      }),
    });
    const dialog = await openSave();
    expect(within(dialog).getByRole('radio', { name: /Only me/ })).toBeTruthy();
    expect(
      within(dialog).getByText('Everyone: every admin who can see products gets it as a tab.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Beef ' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Everyone/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: 'catalog/admin/saved-filters',
      csrf: 'csrf-1',
      body: {
        listKey: 'admin.catalog.products',
        name: 'Beef',
        visibility: 'everyone',
        payload: {
          v: 1,
          view: 'active',
          q: 'beef',
          filters: {},
          sort: 'updated',
          direction: 'desc',
        },
      },
    });
    expect(await screen.findByText('Saved “Beef”')).toBeTruthy();
  });

  it('tells the products-only role the filter is saved for them only, and sends me', async () => {
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

  it('asks for a name, and says under the field when the name is taken', async () => {
    writeReply = () => ({
      ok: false,
      failure: { status: 409, code: 'saved-filter.name-taken' },
    });
    const dialog = await openSave();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    expect(await within(dialog).findByText('Enter a name for the filter.')).toBeTruthy();
    expect(writes).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Paused lamb' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    expect(
      await within(dialog).findByText(
        'A filter with this name already exists. Choose another name.',
      ),
    ).toBeTruthy();
  });

  it('says a limit and a failure in a banner', async () => {
    writeReply = () => ({
      ok: false,
      failure: { status: 409, code: 'saved-filter.limit-reached' },
    });
    const dialog = await openSave();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Another' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    expect(
      await within(dialog).findByText(
        'You can keep up to 50 saved filters. Delete one to save another.',
      ),
    ).toBeTruthy();
    writeReply = () => ({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    expect(
      await within(dialog).findByText('The filter could not be saved. Try again.'),
    ).toBeTruthy();
  });

  async function openManage() {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage filters' }));
    return screen.findByRole('dialog', { name: 'Manage filters' });
  }

  it('lists every view, with actions only on the ones this admin may manage', async () => {
    const dialog = await openManage();
    expect(within(dialog).getByText('Paused lamb')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Edit Paused lamb' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Delete Needs review' })).toBeTruthy();
    expect(within(dialog).getByText('Team picks')).toBeTruthy();
    expect(within(dialog).getByText('Shared by another admin')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Edit Team picks' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete Team picks' })).toBeNull();
  });

  it('renames a view and changes who can use it', async () => {
    writeReply = () => ({
      ok: true,
      status: 200,
      body: filter({ id: MINE, name: 'Paused lamb 2', visibility: 'everyone' }),
    });
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Paused lamb' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Paused lamb 2' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Everyone/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PUT',
      path: `catalog/admin/saved-filters/${MINE}`,
      csrf: 'csrf-1',
      body: { name: 'Paused lamb 2', visibility: 'everyone' },
    });
    expect(await screen.findByText('Updated “Paused lamb 2”')).toBeTruthy();
  });

  it('does not offer Everyone to a role that cannot share', async () => {
    canShare = false;
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Paused lamb' }));
    expect(
      within(dialog).getByText('Saved for you only. Your role can’t share filters.'),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
  });

  it('asks once before deleting, then removes the view and refreshes the tabs', async () => {
    writeReply = () => ({ ok: true, status: 200, body: { id: MINE } });
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Paused lamb' }));
    expect(writes).toHaveLength(0);
    expect(
      within(dialog).getByText('Delete “Paused lamb”? It is removed from your tabs.'),
    ).toBeTruthy();
    saved = SAVED.filter((item) => item.id !== MINE);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete filter' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'DELETE',
      path: `catalog/admin/saved-filters/${MINE}`,
      csrf: 'csrf-1',
      body: undefined,
    });
    expect(await screen.findByText('Deleted “Paused lamb”')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Paused lamb/ })).toBeNull());
  });

  it('warns that deleting a shared view removes it for every admin', async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Needs review' }));
    expect(
      within(dialog).getByText(
        'Delete “Needs review”? It is removed from the tabs of every admin.',
      ),
    ).toBeTruthy();
  });

  it('says there are no saved filters yet', async () => {
    saved = [];
    const dialog = await openManage();
    expect(within(dialog).getByText('No saved filters yet')).toBeTruthy();
  });
});
