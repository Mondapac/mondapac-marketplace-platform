// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast, Toaster } from '@mondapac/ui';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { InvoicesList } from './invoices/invoices-list.tsx';
import { RefundsList } from './refunds/refunds-list.tsx';
import { ShipmentsList } from './shipments/shipments-list.tsx';

// The saved filters of the three Sales lists, end to end against a fake of the generic routes
// (`lists/admin/saved-filters`): the same behaviour for each list, with its own tab, key and body.

const call = vi.mocked(callApi);
const CSRF = 'csrf-1';
const SAVED = 'lists/admin/saved-filters';

interface Case {
  readonly name: string;
  readonly key: string;
  readonly path: string;
  /** The page answer of an empty list, so no row fixture is needed. */
  readonly page: object;
  readonly element: (paging: 'pages' | 'prev-next') => ReactElement;
  /** The built-in tab that is not the default, as its button reads, and its canonical id. */
  /** The sort field to choose in the Sort panel (radio name) and the sort id it saves. */
  readonly sortChoice: { readonly radio: string; readonly id: string };
  readonly otherTab: { readonly button: RegExp; readonly id: string };
  /** The count the other tab shows in the unfiltered list, and a request part only the saved filter sends. */
  readonly otherTabCount: number;
  readonly narrowedBy: string;
  /** A saved document, and the query parameters opening it must send. */
  readonly open: { readonly payload: object; readonly sends: Record<string, string> };
}

const base = { total: 0, page: 1, pageSize: 25, nextCursor: null, searchCapped: false };
const COMMON = { accountId: 'acc-1', marketId: 'AU', zone: 'Australia/Brisbane', csrfToken: CSRF };

const CASES: readonly Case[] = [
  {
    name: 'Shipments',
    key: 'admin.ordering.shipments',
    path: 'ordering/admin/shipments',
    page: {
      ...base,
      shipments: [],
      searchScope: null,
      counts: { toPrepare: 5, ready: 4, shipped: 3, delivered: 2, refunded: 1, attention: 7 },
    },
    element: (paging) => <ShipmentsList paging={paging} {...COMMON} />,
    sortChoice: { radio: 'Total', id: 'total' },
    otherTab: { button: /^Shipped/, id: 'shipped' },
    otherTabCount: 3,
    narrowedBy: 'deliveryMethod=pickup',
    open: {
      payload: {
        v: 1,
        tab: 'delivered',
        filters: { deliveryMethod: 'pickup' },
        sort: 'total',
        direction: 'asc',
      },
      sends: { stage: 'delivered', deliveryMethod: 'pickup', sort: 'total', direction: 'asc' },
    },
  },
  {
    name: 'Refunds',
    key: 'admin.ordering.refunds',
    path: 'ordering/admin/refunds',
    page: {
      ...base,
      refunds: [],
      searchScope: null,
      counts: { pending: 3, succeeded: 20, failed: 2 },
    },
    element: (paging) => <RefundsList paging={paging} {...COMMON} />,
    sortChoice: { radio: 'Amount', id: 'amount' },
    otherTab: { button: /^Refused by Stripe/, id: 'failed' },
    otherTabCount: 2,
    narrowedBy: 'reason=damaged',
    open: {
      payload: {
        v: 1,
        tab: 'pending',
        filters: { reason: 'damaged' },
        sort: 'amount',
        direction: 'asc',
      },
      sends: { state: 'pending', reason: 'damaged', sort: 'amount', direction: 'asc' },
    },
  },
  {
    name: 'Invoices',
    key: 'admin.ordering.documents',
    path: 'ordering/admin/documents',
    page: {
      ...base,
      documents: [],
      searchScope: null,
      counts: { orderConfirmations: 4, creditNotes: 2 },
    },
    element: (paging) => <InvoicesList paging={paging} {...COMMON} />,
    sortChoice: { radio: 'Amount', id: 'amount' },
    otherTab: { button: /^Credit notes/, id: 'credit-note' },
    otherTabCount: 2,
    narrowedBy: 'from=',
    open: {
      payload: {
        v: 1,
        tab: 'credit-note',
        filters: { issued: 'today' },
        sort: 'amount',
        direction: 'asc',
      },
      sends: { kind: 'credit-note', sort: 'amount', direction: 'asc' },
    },
  },
];

interface Stored {
  id: string;
  listKey: string;
  name: string;
  visibility: 'me' | 'everyone';
  payload: object;
  ownedByMe: boolean;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}
const stored = (key: string, over: Partial<Stored>): Stored => ({
  id: '0190a000-0000-7000-8000-000000000a01',
  listKey: key,
  name: 'Mine',
  visibility: 'me',
  payload: { v: 1, tab: 'all' },
  ownedByMe: true,
  canManage: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const ID_A = '0190a000-0000-7000-8000-000000000a01';
const ID_B = '0190a000-0000-7000-8000-000000000a02';
const ID_C = '0190a000-0000-7000-8000-000000000a03';

const fail = (status: number, code: string) =>
  Promise.resolve({ ok: false, failure: { status, code } } as never);
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: true, status, body } as never);

/** A fake of the generic routes holding `items`; the list's own route answers its empty page. */
function serve(
  c: Case,
  items: Stored[],
  options: { canShare?: boolean; savedFails?: number } = {},
) {
  const state = { items };
  call.mockImplementation((method: string, path: string, body?: unknown) => {
    if (!path.startsWith(SAVED)) {
      // Like the API, the list route counts for the filters of the request.
      if (!path.includes(c.narrowedBy)) return ok(c.page);
      const counts = Object.fromEntries(
        Object.keys((c.page as { counts: object }).counts).map((k) => [k, 0]),
      );
      return ok({ ...c.page, counts });
    }
    if (options.savedFails !== undefined) return fail(options.savedFails, 'access.denied');
    if (method === 'GET') {
      return ok({ listKey: c.key, items: state.items, canShare: options.canShare ?? false });
    }
    if (method === 'POST') {
      const sent = body as { name: string; visibility: 'me' | 'everyone'; payload: object };
      const made = stored(c.key, {
        id: ID_C,
        name: sent.name,
        visibility: sent.visibility,
        payload: sent.payload,
      });
      state.items = [...state.items, made];
      return ok(made, 201);
    }
    if (method === 'PUT' && path === `${SAVED}/order`) {
      const sent = body as { ids: string[] };
      state.items = sent.ids.map((id) => state.items.find((item) => item.id === id)!);
      return ok({ listKey: c.key, ids: sent.ids });
    }
    if (method === 'PUT') {
      const sent = body as { name: string; visibility: 'me' | 'everyone' };
      const id = path.slice(`${SAVED}/`.length);
      state.items = state.items.map((item) => (item.id === id ? { ...item, ...sent } : item));
      return ok(state.items.find((item) => item.id === id));
    }
    const id = path.slice(`${SAVED}/`.length).split('?')[0];
    state.items = state.items.filter((item) => item.id !== id);
    return ok({ id });
  });
}

const listUrls = (c: Case) =>
  call.mock.calls.map((entry) => entry[1]).filter((url) => url.startsWith(c.path));
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);
const savedCalls = (method: string) =>
  call.mock.calls.filter((entry) => entry[0] === method && entry[1].startsWith(SAVED));

function mount(c: Case, paging: 'pages' | 'prev-next' = 'pages') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {c.element(paging)}
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no modal dialog: the kit's dialogs open by the attribute.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  toast.dismiss();
});

describe.each(CASES)('$name saved filters', (c) => {
  it('loads the saved tabs from the generic route, after the built-in tabs', async () => {
    serve(c, [
      stored(c.key, { name: 'Mine' }),
      stored(c.key, {
        id: ID_B,
        name: 'Shared by Sam',
        ownedByMe: false,
        canManage: false,
        visibility: 'everyone',
      }),
    ]);
    mount(c);
    const mine = await screen.findByRole('button', { name: 'Mine' });
    expect(call).toHaveBeenCalledWith('GET', `${SAVED}?listKey=${c.key}`);
    const tabs = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-pressed'));
    expect(tabs.indexOf(mine)).toBe(tabs.length - 2);
    expect(tabs[tabs.length - 1]?.textContent).toBe('Shared by Sam');
    expect(screen.getByRole('button', { name: 'Manage filters' })).toBeTruthy();
  });

  it("keeps the built-in tabs' counts when a saved filter is open", async () => {
    serve(c, [stored(c.key, { name: 'Mine', payload: c.open.payload })]);
    mount(c);
    const other = await screen.findByRole('button', { name: c.otherTab.button });
    await waitFor(() => expect(other.textContent).toContain(`(${c.otherTabCount})`));
    fireEvent.click(await screen.findByRole('button', { name: 'Mine' }));
    await waitFor(() => expect(listUrls(c).some((url) => url.includes(c.narrowedBy))).toBe(true));
    // The saved filter narrows its own list only; the other tabs still count the whole list.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: c.otherTab.button }).textContent).toContain(
        `(${c.otherTabCount})`,
      ),
    );
    expect(screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens a saved tab with its tab, filters and sort', async () => {
    serve(c, [stored(c.key, { name: 'Mine', payload: c.open.payload })]);
    mount(c);
    fireEvent.click(await screen.findByRole('button', { name: 'Mine' }));
    await waitFor(() => {
      const last = listUrls(c).at(-1)!;
      expect(paramsOf(last)).toMatchObject(c.open.sends);
    });
    expect(screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('true');
    // Changing a filter leaves the saved tab: it is no longer that filter.
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove filter/ })[0]!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe(
        'false',
      ),
    );
  });

  it('saves the tab as the canonical payload (no search, no default sort) and shows it', async () => {
    serve(c, []);
    mount(c);
    await screen.findByRole('button', { name: 'Manage filters' });
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: c.otherTab.button }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    expect(
      within(dialog).getByText('Saved for you only. Your role can’t share filters.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' My view ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'My view' });
    expect(call).toHaveBeenCalledWith(
      'POST',
      SAVED,
      { listKey: c.key, name: 'My view', visibility: 'me', payload: { v: 1, tab: c.otherTab.id } },
      CSRF,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'My view' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
  });

  it('offers Everyone only to an admin who can share, and sends it', async () => {
    serve(c, [], { canShare: true });
    mount(c);
    await screen.findByRole('button', { name: 'Manage filters' });
    fireEvent.click(screen.getByRole('button', { name: c.otherTab.button }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Everyone' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Team' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'Team' });
    expect(savedCalls('POST')[0]?.[2]).toMatchObject({ visibility: 'everyone' });
  });

  it('does not offer sharing without the permission', async () => {
    serve(c, [stored(c.key, { name: 'Mine' })], { canShare: false });
    mount(c);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage filters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage filters' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Mine' }));
    expect(within(dialog).queryByRole('radio', { name: 'Everyone' })).toBeNull();
    expect(
      within(dialog).getByText('Saved for you only. Your role can’t share filters.'),
    ).toBeTruthy();
  });

  it('renames, deletes and reorders from Manage filters', async () => {
    serve(c, [
      stored(c.key, { id: ID_A, name: 'First' }),
      stored(c.key, { id: ID_B, name: 'Second' }),
      stored(c.key, {
        id: ID_C,
        name: 'Theirs',
        ownedByMe: false,
        canManage: false,
        visibility: 'everyone',
      }),
    ]);
    mount(c);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage filters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage filters' });

    // The first own filter cannot move up; another admin's filter has no move buttons.
    expect(within(dialog).getByRole('button', { name: 'Move First up' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(dialog).queryByRole('button', { name: 'Move Theirs down' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move First down' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `${SAVED}/order`,
        { listKey: c.key, ids: [ID_B, ID_A] },
        CSRF,
      ),
    );
    await screen.findByText('Moved “First”');
    // The row keeps focus: the Move down button it used is now disabled (last own row), so
    // focus goes to its Move up button.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: 'Move First up' }),
      ),
    );
    expect(
      within(dialog).getByRole('button', { name: 'Move First up' }).getAttribute('title'),
    ).toBe('Move First up');
    await waitFor(() => {
      const names = within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent ?? '');
      expect(names[0]).toContain('Second');
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit First' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `${SAVED}/${ID_A}`,
        { listKey: c.key, name: 'Renamed', visibility: 'me' },
        CSRF,
      ),
    );

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Delete Renamed' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete filter' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'DELETE',
        `${SAVED}/${ID_A}?listKey=${c.key}`,
        undefined,
        CSRF,
      ),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Renamed' })).toBeNull());
  });

  it.each([
    [403, 'access.denied'],
    [404, 'not-found'],
    [503, 'access.unavailable'],
  ])(
    'hides the saved-filter controls when the route answers %i, and the list still works',
    async (status) => {
      serve(c, [], { savedFails: status });
      mount(c);
      await waitFor(() => expect(listUrls(c).length).toBeGreaterThan(0));
      fireEvent.click(screen.getByRole('button', { name: c.otherTab.button }));
      await waitFor(() =>
        expect(paramsOf(listUrls(c).at(-1)!)).not.toEqual(paramsOf(listUrls(c)[0]!)),
      );
      expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
      expect(
        screen.getByRole('button', { name: c.otherTab.button }).getAttribute('aria-pressed'),
      ).toBe('true');
    },
  );

  it('keeps the sort and direction through save and reopen under page numbers', async () => {
    serve(c, []);
    mount(c, 'pages');
    await screen.findByRole('button', { name: 'Manage filters' });
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const sort = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(sort).getByRole('radio', { name: c.sortChoice.radio }));
    fireEvent.click(within(sort).getByRole('radio', { name: 'Lowest first' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'By amount' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'By amount' });
    expect(savedCalls('POST')[0]?.[2]).toMatchObject({
      payload: { sort: c.sortChoice.id, direction: 'asc' },
    });
    // Leave the saved tab, then open it again: the sort comes back from the payload.
    fireEvent.click(screen.getByRole('button', { name: c.otherTab.button }));
    await waitFor(() => expect(paramsOf(listUrls(c).at(-1)!)['direction']).toBe('desc'));
    fireEvent.click(screen.getByRole('button', { name: 'By amount' }));
    await waitFor(() =>
      expect(paramsOf(listUrls(c).at(-1)!)).toMatchObject({
        sort: c.sortChoice.id,
        direction: 'asc',
      }),
    );
  });

  it('saves and reopens without any sort under Previous and next', async () => {
    serve(c, []);
    mount(c, 'prev-next');
    await screen.findByRole('button', { name: 'Manage filters' });
    fireEvent.click(screen.getByRole('button', { name: c.otherTab.button }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Tab only' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'Tab only' });
    expect(savedCalls('POST')[0]?.[2]).toMatchObject({
      payload: { v: 1, tab: c.otherTab.id },
    });
    expect(savedCalls('POST')[0]?.[2]).not.toHaveProperty('payload.sort');
    const sent = paramsOf(listUrls(c).at(-1)!);
    expect(sent).not.toHaveProperty('sort');
    expect(sent).not.toHaveProperty('direction');
  });

  it('opens the new tab as its own reopen: first page, no cursor, no search', async () => {
    serve(c, []);
    mount(c, 'pages');
    await screen.findByRole('button', { name: 'Manage filters' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'Cedar' },
    });
    fireEvent.click(screen.getByRole('button', { name: c.otherTab.button }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Fresh' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'Fresh' });
    await waitFor(() => {
      const sent = paramsOf(listUrls(c).at(-1)!);
      expect(sent['page']).toBe('1');
      expect(sent).not.toHaveProperty('search');
      expect(sent).not.toHaveProperty('q');
    });
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search' }).value).toBe('');
  });

  it('does not save the sort under Previous and next, which has no sort', async () => {
    serve(c, [stored(c.key, { name: 'Mine', payload: c.open.payload })]);
    mount(c, 'prev-next');
    fireEvent.click(await screen.findByRole('button', { name: 'Mine' }));
    await waitFor(() => expect(listUrls(c).length).toBeGreaterThan(1));
    const sent = paramsOf(listUrls(c).at(-1)!);
    expect(sent).not.toHaveProperty('sort');
    expect(sent).not.toHaveProperty('direction');
  });
});

describe('Shipments saved filters: the payload keeps what the admin changed', () => {
  it('sends the filters and the sort, never the search text', async () => {
    const c = CASES[0]!;
    serve(c, []);
    mount(c);
    await screen.findByRole('button', { name: 'Manage filters' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'Cedar' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'paid' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'today' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const sort = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(sort).getByRole('radio', { name: 'Total' }));
    fireEvent.click(within(sort).getByRole('radio', { name: 'Lowest first' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    expect(within(dialog).getByText(/Paid is Today/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Cheap today' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'Cheap today' });
    expect(savedCalls('POST')[0]?.[2]).toEqual({
      listKey: c.key,
      name: 'Cheap today',
      visibility: 'me',
      payload: { v: 1, tab: 'all', filters: { paid: 'today' }, sort: 'total', direction: 'asc' },
    });
  });
});
