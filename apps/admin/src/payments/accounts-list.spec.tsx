// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AccountsList } from './accounts-list.tsx';
import { cleanColumns } from './list/accounts-columns.ts';
import { exportParams } from './list/accounts-export.tsx';
import {
  DEFAULT_QUERY,
  filtersOf,
  type AccountListPage,
  type AccountListRow,
} from './list/accounts-list-types.ts';
import { accountSearchRoute, queryString } from './list/accounts-query.ts';

// The Seller accounts super list (list 22): views with counts, the one search box (seller id or
// store name), filters, sort, columns, both List paging modes, selection and Export, and the row
// Actions menu (Open only: the list is read-only).

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const SELLER = '0190a000-0000-7000-8000-000000000001';
const sellerId = (n: number) => `0190a000-0000-7000-8000-00000000000${n}`;
const STORE = 'Cedar Lane Halal Meats';
const LIST = 'payments/admin/connected-accounts';

const row = (over: Partial<AccountListRow> = {}): AccountListRow => ({
  sellerId: SELLER,
  sellerName: STORE,
  status: 'enabled',
  ready: true,
  requirementsDue: 0,
  requirementsPastDue: false,
  coolingOffUntil: null,
  payoutsPaused: false,
  lastReadAt: '2026-10-13T01:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  actions: ['open'],
  ...over,
});
const COUNTS = {
  all: 40,
  'not-started': 3,
  pending: 5,
  enabled: 28,
  restricted: 3,
  rejected: 1,
};
const pageOf = (items: AccountListRow[], over: Partial<AccountListPage> = {}): AccountListPage => ({
  items,
  counts: COUNTS,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  searchCapped: false,
  ...over,
});
/** The answer of Previous and next: no total and no counts. */
const openPage = (items: AccountListRow[], page: number, hasNext: boolean) =>
  pageOf(items, { counts: null, total: null, page, paging: 'prev-next', hasNext });

type Answer = AccountListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string) =>
  Promise.resolve({ ok: false, failure: { status, code, details: { fields: [] } } } as never);

function serve(answer: (url: string) => Answer) {
  call.mockImplementation((method, path) => {
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return failure(404, 'not-found');
    const result = answer(path);
    if (result === 'fail') return failure(503, 'payments.unavailable');
    if (result === 'denied') return failure(403, 'access.denied');
    if (result === 'unauthenticated') return failure(401, 'session.invalid');
    if (result === 'refused') return failure(400, 'validation.failed');
    return Promise.resolve({ ok: true, status: 200, body: result } as never);
  });
}
const listUrls = () =>
  call.mock.calls
    .filter((entry) => entry[0] === 'GET' && entry[1].startsWith(`${LIST}?`))
    .map((entry) => entry[1]);
const lastParams = () => {
  const urls = listUrls();
  return Object.fromEntries(new URL(`http://x/${urls[urls.length - 1]!}`).searchParams);
};

function mount(paging: 'pages' | 'prev-next' = 'pages') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AccountsList paging={paging} accountId="acc-1" marketId="AU" zone={BRISBANE} />
    </NextIntlClientProvider>,
  );
}
const storeLink = () => screen.findByRole('link', { name: STORE });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Seller accounts list: page numbers', () => {
  it('asks for page 1, newest first, and shows the views with counts, the row and the range', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    const link = await storeLink();
    expect(link.getAttribute('href')).toBe(`/payout-accounts/${SELLER}`);
    expect(lastParams()).toEqual({
      sort: 'created',
      direction: 'desc',
      paging: 'pages',
      page: '1',
      pageSize: '25',
    });
    expect(screen.getByRole('button', { name: 'All (40)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('1–1 of 143 accounts')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restricted (3)' }));
    await waitFor(() => expect(lastParams()['status']).toBe('restricted'));
  });

  it('shows status, readiness, details due and the optional columns', async () => {
    serve(() =>
      pageOf([
        row(),
        row({
          sellerId: sellerId(2),
          sellerName: null,
          status: 'restricted',
          ready: false,
          requirementsDue: 2,
          requirementsPastDue: true,
          coolingOffUntil: '2026-10-16T03:30:00.000Z',
          payoutsPaused: true,
          lastReadAt: null,
        }),
      ]),
    );
    mount();
    await storeLink();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Unnamed seller')).toBeTruthy();
    expect(within(table).getByText('Restricted')).toBeTruthy();
    expect(within(table).getByText('Past due')).toBeTruthy();
    expect(within(table).getByText(/16 Oct/)).toBeTruthy();
    expect(within(table).getByText('Never')).toBeTruthy();
  });

  it('has no button in a row but its Actions menu, which offers Open', async () => {
    serve(() => pageOf([row({ actions: ['open', 'suspend'] })]));
    mount();
    await storeLink();
    const buttons = within(screen.getByRole('table'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual([`Actions for ${STORE}`]);
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${STORE}` }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith(`/payout-accounts/${SELLER}`);
  });

  it('sends a seller id or a store name as q, and nothing for one letter', async () => {
    serve(() => pageOf([row()]));
    mount();
    await storeLink();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: SELLER.toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(SELLER));
    expect(screen.getByText(`Seller ID is ${SELLER}`)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'cedar' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe('cedar'));
    expect(screen.getByText('Store contains "cedar"')).toBeTruthy();
    const before = listUrls().length;
    fireEvent.change(box, { target: { value: 'c' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Type at least 2 characters/)).toBeTruthy();
    expect(listUrls()).toHaveLength(before);
  });

  it('says when the store search matched too many stores', async () => {
    serve(() => pageOf([row()], { searchCapped: true }));
    mount();
    expect(await screen.findByText(/matched too many stores/)).toBeTruthy();
  });

  it('filters from the panel and shows the filter as a removable chip', async () => {
    serve(() => pageOf([row()], { total: 7 }));
    mount();
    await storeLink();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'requirements' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'past-due' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastParams()['requirements']).toBe('past-due'));
    expect(screen.getByText('7 accounts match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Remove filter Details due/ }));
    await waitFor(() => expect(lastParams()['requirements']).toBeUndefined());
  });

  it('sorts by details due, most first, from the sort panel', async () => {
    serve(() => pageOf([row()]));
    mount();
    await storeLink();
    expect(screen.getByText('Sorted by Created: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Details due' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('requirements'));
    expect(lastParams()['direction']).toBe('desc');
  });

  it('keeps the ticked rows over paging, and drops them for another view', async () => {
    serve((url) =>
      url.includes('page=2')
        ? pageOf([row({ sellerId: sellerId(2), sellerName: 'Olive Grove' })], {
            total: 30,
            page: 2,
          })
        : pageOf([row()], { total: 30 }),
    );
    mount();
    await storeLink();
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${STORE}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await screen.findByRole('link', { name: 'Olive Grove' })).toBeTruthy();
    expect(screen.getByText('1 account selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pending (5)' }));
    await waitFor(() => expect(screen.queryByText('1 account selected')).toBeNull());
  });

  it('goes back to the last page with rows when a page is past the end', async () => {
    serve((url) => {
      if (url.includes('page=4')) return pageOf([], { total: 30, page: 4 });
      if (url.includes('page=2'))
        return pageOf([row({ sellerId: sellerId(2), sellerName: 'Olive Grove' })], {
          total: 30,
          page: 2,
        });
      return pageOf([row()], { total: 90 });
    });
    mount();
    await storeLink();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(await screen.findByRole('link', { name: 'Olive Grove' })).toBeTruthy();
    expect(listUrls().map((url) => new URL(`http://x/${url}`).searchParams.get('page'))).toEqual([
      '1',
      '4',
      '2',
    ]);
  });

  it('says the API refused the query without a Try again, and offers one when it is down', async () => {
    serve(() => 'refused');
    mount();
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
    serve(() => 'fail');
    mount();
    expect(await screen.findByText('The seller accounts could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await storeLink()).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText("You don't have access to connected accounts.")).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/payout-accounts' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the empty state of a view, and a no-match state with Clear all', async () => {
    serve((url) => (url.includes('q=') ? pageOf([]) : pageOf([], { total: 0 })));
    mount();
    expect(await screen.findByText(/No connected accounts yet/)).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'nobody' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('No seller accounts match')).toBeTruthy();
  });

  it('renders store names as plain text', async () => {
    serve(() => pageOf([row({ sellerName: '<img src=x onerror=alert(1)>' })]));
    mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Seller accounts list: Previous and next', () => {
  it('asks with paging prev-next, shows no counts, and steps with Next and Previous', async () => {
    serve((url) =>
      url.includes('page=2')
        ? openPage([row({ sellerId: sellerId(2), sellerName: 'Olive Grove' })], 2, false)
        : openPage([row()], 1, true),
    );
    mount('prev-next');
    await storeLink();
    expect(lastParams()['paging']).toBe('prev-next');
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('link', { name: 'Olive Grove' })).toBeTruthy();
    expect(lastParams()['page']).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(lastParams()['page']).toBe('1'));
  });

  it('steps back once when a page comes back empty', async () => {
    serve((url) => (url.includes('page=2') ? openPage([], 2, false) : openPage([row()], 1, true)));
    mount('prev-next');
    await storeLink();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listUrls()).toHaveLength(3));
    expect(lastParams()['page']).toBe('1');
  });
});

describe('Seller accounts list: queries and export', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('builds the list query', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'restricted' as const,
      q: 'cedar',
      filters: {
        ready: 'no' as const,
        requirements: 'due' as const,
        waiting: 'paused' as const,
        created: 'today' as const,
      },
      sort: 'last-read' as const,
      direction: 'asc' as const,
      page: 3,
    };
    expect(Object.fromEntries(new URLSearchParams(queryString(query, context)))).toEqual({
      status: 'restricted',
      q: 'cedar',
      ready: 'no',
      requirements: 'due',
      waiting: 'paused',
      // The 17th in Brisbane (UTC+10).
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      sort: 'last-read',
      direction: 'asc',
      paging: 'pages',
      page: '3',
      pageSize: '25',
    });
  });

  it('routes the search box text, and keeps only known filters and columns', () => {
    expect(accountSearchRoute('  ')).toEqual({ kind: 'none' });
    expect(accountSearchRoute('x')).toEqual({ kind: 'too-short' });
    expect(accountSearchRoute(SELLER.toUpperCase())).toEqual({ kind: 'id', value: SELLER });
    expect(accountSearchRoute(' Cedar ')).toEqual({ kind: 'store', value: 'Cedar' });
    expect(filtersOf({ ready: 'maybe', waiting: 'paused', created: 'last-7-days' })).toEqual({
      waiting: 'paused',
      created: 'last-7-days',
    });
    expect(cleanColumns(['paused', 'nope', 'seller-id'])).toEqual(['paused', 'seller-id']);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: 'cedar', filters: { created: 'today' as const } };
    const params = (input: Partial<Parameters<typeof exportParams>[0]>) =>
      Object.fromEntries(
        new URLSearchParams(
          exportParams({
            query,
            paging: 'pages',
            zone: BRISBANE,
            format: 'csv',
            columns: [],
            selection: { ids: [], allMatching: false, total: 30 },
            now: NOW,
            ...input,
          }),
        ),
      );
    expect(
      params({
        columns: ['paused', 'seller-id'],
        selection: { ids: [SELLER, sellerId(2)], allMatching: false, total: 30 },
      }),
    ).toEqual({ ids: `${SELLER},${sellerId(2)}`, format: 'csv', columns: 'paused,seller-id' });
    expect(
      params({ format: 'xlsx', selection: { ids: [], allMatching: true, total: null } }),
    ).toEqual({
      q: 'cedar',
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      sort: 'created',
      direction: 'desc',
      format: 'xlsx',
    });
  });

  it('downloads the file of the ticked rows from the Bulk action menu', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response('seller\n1\n', { headers: { 'content-type': 'text/csv' } }),
        );
      }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    serve(() => pageOf([row()]));
    mount();
    await storeLink();
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${STORE}` }));
    fireEvent.click(bulk);
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
    await waitFor(() => expect(fetched).toHaveLength(1));
    const url = new URL(fetched[0]!, 'http://x');
    expect(url.pathname).toBe('/api/payments/admin/connected-accounts/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: SELLER,
      format: 'csv',
      columns: 'cooling-off,paused,last-read',
    });
  });
});
