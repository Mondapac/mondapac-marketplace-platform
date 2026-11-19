// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { cleanColumns, exportColumns } from './list/requests-columns.ts';
import { exportParams } from './list/requests-export.tsx';
import {
  DEFAULT_QUERY,
  filtersOf,
  type DeletionListPage,
  type DeletionListRow,
} from './list/requests-list-types.ts';
import { deletionSearchRoute, queryString } from './list/requests-query.ts';
import { RequestsList } from './requests-list.tsx';

// The Account deletion requests super list (list 25): views with counts, the id-only search,
// filters, sort, columns, both List paging modes, selection and Export, and the one row action,
// Cancel request, with its reason and two-step code.

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const ME = '0190a000-0000-7000-8000-0000000000a1';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const account = (n: number) => `0190a000-0000-7000-8000-00000000a${String(n).padStart(3, '0')}`;
const LIST = 'customers/admin/deletion-requests';
const NAME = 'request for account 0000A001';

const row = (n = 1, over: Partial<DeletionListRow> = {}): DeletionListRow => ({
  requestId: id(n),
  accountId: account(n),
  requestedAt: '2026-11-10T01:00:00.000Z',
  scheduledFor: '2026-12-10T01:00:00.000Z',
  status: 'pending',
  requestedBy: 'customer',
  cancelledAt: null,
  cancelReason: null,
  completedAt: null,
  actions: ['cancel'],
  ...over,
});
const COUNTS = { pending: 3, executing: 1, cancelled: 12, completed: 20, all: 36 };
const pageOf = (
  entries: DeletionListRow[],
  over: Partial<DeletionListPage> = {},
): DeletionListPage => ({
  entries,
  counts: COUNTS,
  total: entries.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  ...over,
});
/** The answer of Previous and next: no total and no page. */
const openPage = (entries: DeletionListRow[], nextCursor: string | null = null) =>
  pageOf(entries, { total: null, page: null, nextCursor });

type Answer = DeletionListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string, details: object = { fields: [] }) =>
  Promise.resolve({ ok: false, failure: { status, code, details } } as never);
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: true, status, body } as never);

/** What a DELETE (cancel) answers; set by the test. */
let remove: () => Promise<never> = () => failure(500, 'unexpected');

function serve(answer: (url: string) => Answer) {
  call.mockImplementation((method, path) => {
    if (method === 'DELETE') return remove();
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return failure(404, 'not-found');
    const result = answer(path);
    if (result === 'fail') return failure(503, 'customers.unavailable');
    if (result === 'denied') return failure(403, 'access.denied');
    if (result === 'unauthenticated') return failure(401, 'session.invalid');
    if (result === 'refused') return failure(400, 'validation.failed');
    return ok(result);
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
const deletes = () => call.mock.calls.filter((entry) => entry[0] === 'DELETE');

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    view?: 'pending' | 'cancelled' | 'completed' | 'all';
    zone?: string;
    marketId?: string;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StepUpProvider>
        <RequestsList
          paging={options.paging ?? 'pages'}
          accountId={ME}
          csrfToken="csrf"
          marketId={options.marketId ?? 'AU'}
          zone={options.zone ?? BRISBANE}
          initialView={options.view ?? 'pending'}
        />
      </StepUpProvider>
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
const accountLink = (n = 1) => screen.findByRole('link', { name: account(n) });
const openMenu = async (name = NAME) => {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};

beforeEach(() => {
  vi.clearAllMocks();
  remove = () => failure(500, 'unexpected');
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
  vi.useRealTimers();
});

describe('Deletion requests list: page numbers', () => {
  it('asks for the waiting view, page 1, earliest deletion first, and shows the views, the row and the range', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    const link = await accountLink();
    expect(link.getAttribute('href')).toBe(`/customers/${account(1)}`);
    expect(lastParams()).toEqual({
      view: 'pending',
      sort: 'scheduled',
      direction: 'asc',
      page: '1',
      pageSize: '25',
    });
    expect(screen.getByRole('button', { name: 'Waiting (3)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const table = screen.getByRole('table');
    for (const header of [
      'Account',
      'Status',
      'Requested',
      'Deletes on',
      'Requested by',
      'Actions',
    ]) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(table).getByText('Waiting', { selector: 'span' })).toBeTruthy();
    expect(within(table).getByText('Buyer')).toBeTruthy();
    expect(screen.getByText('Sorted by Deletes on: Earliest first')).toBeTruthy();
    expect(screen.getByText('1–1 of 143 requests')).toBeTruthy();
    for (const [name, view] of [
      ['In progress (1)', 'executing'],
      ['Cancelled (12)', 'cancelled'],
      ['Deleted (20)', 'completed'],
      ['All (36)', 'all'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(lastParams()['view']).toBe(view));
    }
  });

  it('has no button in a row; its menu offers Cancel request… when the row names it', async () => {
    serve(() => pageOf([row(1, { actions: ['refund', 'cancel'] })]));
    mount();
    await accountLink();
    const buttons = within(screen.getByRole('table'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual([`Actions for ${NAME}`]);
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Cancel request…']);
  });

  it('offers no menu on a row that names no action, and no link to an erased account', async () => {
    serve(() =>
      pageOf([
        row(1, { status: 'executing', actions: [] }),
        row(2, { status: 'completed', actions: [], completedAt: '2026-12-10T02:00:00.000Z' }),
      ]),
    );
    mount({ view: 'all' });
    expect(await accountLink(1)).toBeTruthy();
    expect(screen.queryByRole('link', { name: account(2) })).toBeNull();
    expect(screen.getByText(account(2))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.getByText('In progress', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Deleted', { selector: 'span' })).toBeTruthy();
  });

  it('sends an id as q (lower-case, control characters as spaces); text that is not an id asks nothing', async () => {
    serve(() => pageOf([row()]));
    mount();
    await accountLink();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: `\t${ME.toUpperCase()}\n` } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(ME));
    expect(screen.getByText(`Request or account ID is ${ME}`)).toBeTruthy();
    const before = listUrls().length;
    fireEvent.change(box, { target: { value: 'Ada Lovelace' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/That is not an ID/)).toBeTruthy();
    expect(listUrls()).toHaveLength(before);
    expect(lastParams()['q']).toBe(ME);
  });

  const applyFilter = async (field: string, value: string) => {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: field } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  };

  it('filters from the panel and shows each filter as a removable chip', async () => {
    serve(() => pageOf([row()], { total: 7 }));
    mount({ view: 'cancelled' });
    await accountLink();
    await applyFilter('cancelReason', 'sign-in');
    await waitFor(() => expect(lastParams()['cancelReason']).toBe('sign-in'));
    expect(screen.getByText('7 requests match')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Cancelled because is Buyer signed in' }),
    );
    await waitFor(() => expect(lastParams()['cancelReason']).toBeUndefined());
  });

  it('filters by who asked, by a date preset on the list zone, and by the next days', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    serve(() => pageOf([row()]));
    mount();
    await accountLink();
    await applyFilter('requestedBy', 'admin');
    await waitFor(() => expect(lastParams()['requestedBy']).toBe('admin'));
    expect(screen.getByText('Requested by is Admin')).toBeTruthy();
    await applyFilter('requested', 'today');
    await waitFor(() => expect(lastParams()['from']).toBeDefined());
    // The 17th in Brisbane (UTC+10).
    expect(lastParams()).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    await applyFilter('deletes', '7d');
    await waitFor(() => expect(lastParams()['scheduledBefore']).toBe('2026-11-23T20:30:00.000Z'));
    expect(screen.getByText('Deletes is Within 7 days')).toBeTruthy();
  });

  it('starts each sort on its own first order, and labels the first order as that', async () => {
    serve(() => pageOf([row()]));
    mount();
    await accountLink();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    // The deletion date starts earliest first, so that is its first radio and it is chosen.
    const earliest = await screen.findByRole('radio', { name: 'Earliest first' });
    expect((earliest as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Latest first' }));
    await waitFor(() => expect(lastParams()['direction']).toBe('desc'));
    expect(screen.getByText('Sorted by Deletes on: Latest first')).toBeTruthy();
    // The others start newest first.
    fireEvent.click(screen.getByRole('radio', { name: 'Requested' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('requested'));
    expect(lastParams()['direction']).toBe('desc');
    const newest = screen.getByRole('radio', { name: 'Newest first' });
    expect((newest as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Sorted by Requested: Newest first')).toBeTruthy();
  });

  it('keeps the ticked rows over paging and for the same id in another case, and drops them for another view', async () => {
    serve((url) =>
      url.includes('page=2')
        ? pageOf([row(2)], { total: 30, page: 2 })
        : pageOf([row()], { total: 30 }),
    );
    mount();
    await accountLink();
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NAME}` }));
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: ME } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(ME));
    // A new search is another list: the tick goes.
    await waitFor(() => expect(screen.queryByText('1 request selected')).toBeNull());
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NAME}` }));
    const reads = listUrls().length;
    fireEvent.change(box, { target: { value: ME.toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // The same id in capitals is the same list: the tick stays.
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    await accountLink();
    expect(screen.getByText('1 request selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await accountLink(2)).toBeTruthy();
    expect(screen.getByText('1 request selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled (12)' }));
    await waitFor(() => expect(screen.queryByText('1 request selected')).toBeNull());
  });

  it('goes back to the last page with rows when a page is past the end', async () => {
    serve((url) => {
      if (url.includes('page=4')) return pageOf([], { total: 30, page: 4 });
      if (url.includes('page=2')) return pageOf([row(2)], { total: 30, page: 2 });
      return pageOf([row()], { total: 90 });
    });
    mount();
    await accountLink();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(await accountLink(2)).toBeTruthy();
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
    expect(await screen.findByText('The deletion requests could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await accountLink()).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to this list.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Account deletion' }).getAttribute('href')).toBe(
      '/settings/account-deletion',
    );
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/settings' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the empty state of a view, and a no-match state with Clear all', async () => {
    serve(() => pageOf([], { total: 0 }));
    mount({ view: 'cancelled' });
    expect(await screen.findByText('No requests have been cancelled.')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: ME } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('No deletion requests match')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
    await waitFor(() => expect(lastParams()['q']).toBeUndefined());
  });

  it('shows a status it does not know as plain text', async () => {
    serve(() => pageOf([row(1, { status: 'weird' })]));
    mount();
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('weird')).toBeTruthy();
  });
});

describe('Deletion requests list: Previous and next', () => {
  it('sends limit and the cursor only, with no sort, and steps Next, Next, Previous', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([row(3)]);
      if (url.includes('cursor=c1')) return openPage([row(2)], 'c2');
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await accountLink();
    expect(lastParams()).toEqual({ view: 'pending', limit: '25' });
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
    expect(screen.getByText('Sorted by Deletes on: Earliest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await accountLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await accountLink(3);
    expect(lastParams()).toEqual({ view: 'pending', limit: '25', cursor: 'c2' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await accountLink(2)).toBeTruthy();
    expect(lastParams()).toEqual({ view: 'pending', limit: '25', cursor: 'c1' });
  });

  it('steps back once when a page comes back empty', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([]);
      if (url.includes('cursor=c1')) return openPage([row(2)], 'c2');
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await accountLink();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await accountLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listUrls()).toHaveLength(4));
    expect(lastParams()).toEqual({ view: 'pending', limit: '25', cursor: 'c1' });
    // No further read follows the step back.
    await new Promise((done) => setTimeout(done, 30));
    expect(listUrls()).toHaveLength(4);
  });
});

describe('Deletion requests list: queries and export', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('builds the list query with every filter, and always names the view', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'cancelled' as const,
      q: ME,
      filters: {
        requestedBy: 'admin' as const,
        cancelReason: 'sign-in' as const,
        requested: 'today' as const,
        deletes: '30d' as const,
      },
      sort: 'cancelled' as const,
      direction: 'desc' as const,
      page: 3,
    };
    expect(Object.fromEntries(new URLSearchParams(queryString(query, context)))).toEqual({
      view: 'cancelled',
      q: ME,
      requestedBy: 'admin',
      cancelReason: 'sign-in',
      // The 17th in Brisbane (UTC+10).
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      scheduledBefore: '2026-12-16T20:30:00.000Z',
      sort: 'cancelled',
      direction: 'desc',
      page: '3',
      pageSize: '25',
    });
    expect(
      queryString({ ...DEFAULT_QUERY, cursors: ['a', 'b'] }, { ...context, paging: 'prev-next' }),
    ).toBe('view=pending&limit=25&cursor=b');
  });

  it('reads the date preset on the clock of the list zone', () => {
    const query = { ...DEFAULT_QUERY, filters: { requested: 'today' as const } };
    const auckland = new URLSearchParams(
      queryString(query, { ...context, zone: 'Pacific/Auckland' }),
    );
    // 21:30 on the 17th in Auckland (UTC+13): the 17th starts at 11:00 UTC on the 16th.
    expect(auckland.get('from')).toBe('2026-11-16T11:00:00.000Z');
  });

  it('routes the search box text, and keeps only known filters and columns', () => {
    expect(deletionSearchRoute('  ')).toEqual({ kind: 'none' });
    expect(deletionSearchRoute('x')).toEqual({ kind: 'not-id' });
    expect(deletionSearchRoute('a@example.test')).toEqual({ kind: 'not-id' });
    // A v4 UUID is not an id the API knows.
    expect(deletionSearchRoute('3f2c9a8e-1b4d-4c6e-9f00-112233445566')).toEqual({ kind: 'not-id' });
    expect(deletionSearchRoute(ME.toUpperCase())).toEqual({ kind: 'id', value: ME });
    expect(deletionSearchRoute(` ${ME}\t`)).toEqual({ kind: 'id', value: ME });
    expect(
      filtersOf({ requestedBy: 'seller', cancelReason: 'sign-in', deletes: '1y', requested: 'x' }),
    ).toEqual({ cancelReason: 'sign-in' });
    expect(cleanColumns(['completed', 'nope', 'cancelled'])).toEqual(['completed', 'cancelled']);
  });

  it('maps the columns on screen to the columns of the export', () => {
    expect(exportColumns(['requested-by', 'completed', 'cancel-reason', 'cancelled'])).toEqual([
      'completed',
      'cancel-reason',
      'cancelled',
    ]);
    expect(exportColumns(['requested-by'])).toEqual([]);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: ME, sort: 'requested' as const };
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
        columns: ['requested-by', 'cancelled', 'completed'],
        selection: { ids: [id(1), id(2)], allMatching: false, total: 30 },
      }),
    ).toEqual({ ids: `${id(1)},${id(2)}`, format: 'csv', columns: 'cancelled,completed' });
    expect(
      params({
        paging: 'prev-next',
        format: 'xlsx',
        selection: { ids: [], allMatching: true, total: null },
      }),
    ).toEqual({
      view: 'pending',
      q: ME,
      sort: 'scheduled',
      direction: 'asc',
      format: 'xlsx',
    });
    expect(params({ selection: { ids: [], allMatching: true, total: 30 } })).toMatchObject({
      sort: 'requested',
      direction: 'asc',
    });
    expect(() => params({})).toThrow('export.no-rows-selected');
  });

  it('downloads the file of the ticked rows from the Bulk action menu', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response('id\n1\n', { headers: { 'content-type': 'text/csv' } }),
        );
      }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    serve(() => pageOf([row()]));
    mount();
    await accountLink();
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NAME}` }));
    fireEvent.click(bulk);
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    // Export is the only bulk action: nothing is cancelled or deleted in bulk.
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Export/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
    await waitFor(() => expect(fetched).toHaveLength(1));
    const url = new URL(fetched[0]!, 'http://x');
    expect(url.pathname).toBe('/api/customers/admin/deletion-requests/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({ ids: id(1), format: 'csv' });
  });
});

describe('Deletion requests list: Cancel request', () => {
  const openCancel = async () => {
    serve(() => pageOf([row(), row(2)]));
    mount();
    await accountLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Cancel request…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this deletion request?' });
    expect(within(dialog).getByText(/The buyer is not told/)).toBeTruthy();
    expect(within(dialog).getByText("Not saved. Don't enter personal data.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Reason'));
    return dialog;
  };
  const typeReason = (dialog: HTMLElement, value = 'Buyer asked by phone') =>
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value } });
  const confirm = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));

  it('cancels with a reason and the code, says so, reads the list again and focuses it', async () => {
    const dialog = await openCancel();
    typeReason(dialog);
    remove = () => ok(null, 204);
    const reads = listUrls().length;
    confirm(dialog);
    await expectToast('Deletion request cancelled. The account is kept.');
    expect(deletes()).toEqual([
      ['DELETE', `${LIST}/${id(1)}`, { reason: 'Buyer asked by phone' }, 'csrf'],
    ]);
    // No optimistic edit: the rows come from the next read.
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active.tabIndex).toBe(-1);
      expect(active.contains(screen.getByRole('table'))).toBe(true);
    });
  });

  it('keeps the request when the dialog is closed with "Keep request" or the reason is bad', async () => {
    const dialog = await openCancel();
    confirm(dialog);
    expect(within(dialog).getByText(/Enter a reason of 1 to 500/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep request' }));
    expect(deletes()).toHaveLength(0);
    expect(screen.getByRole('link', { name: account(1) })).toBeTruthy();
  });

  it('starts each opening with an empty reason', async () => {
    const dialog = await openCancel();
    typeReason(dialog, 'first reason');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep request' }));
    fireEvent.click(
      within(await openMenu('request for account 0000A002')).getByRole('menuitem', {
        name: 'Cancel request…',
      }),
    );
    const again = await screen.findByRole('dialog', { name: 'Cancel this deletion request?' });
    expect(within(again).getByLabelText<HTMLTextAreaElement>('Reason').value).toBe('');
  });

  it('a cancelled code leaves the row and shows nothing', async () => {
    const dialog = await openCancel();
    typeReason(dialog);
    remove = () =>
      failure(403, 'second-factor.required', { actionKey: 'customers.buyer-account.delete' });
    confirm(dialog);
    const code = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    const reads = listUrls().length;
    fireEvent.click(within(code).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: account(1) })).toBeTruthy();
    // A cancelled code changed nothing: the list is not read again.
    expect(listUrls()).toHaveLength(reads);
  });

  it.each([
    [
      'customers.account-deletion-in-progress',
      409,
      "This account is already being deleted. It can't be cancelled.",
    ],
    ['customers.account-deletion-request-not-found', 404, 'This request is no longer pending.'],
    [
      'customers.conflict',
      409,
      'Another admin changed this setting. Reload the page to see the current value.',
    ],
    ['access.denied', 403, "You don't have permission to change this."],
    ['customers.unavailable', 503, "Couldn't check this account. Try again."],
    [
      'access.unavailable',
      503,
      'The service is not available right now. Try again in a few minutes.',
    ],
    // No answer at all: the cancel may have gone through, so the list is read again too.
    [
      'network.unreachable',
      0,
      'The service is not available right now. Try again in a few minutes.',
    ],
  ])('answers %s with a banner and reads the list again', async (code, status, text) => {
    const dialog = await openCancel();
    typeReason(dialog);
    remove = () => failure(status, code);
    const reads = listUrls().length;
    confirm(dialog);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(dialog.hasAttribute('open')).toBe(false);
    // The focus goes to the message, after the closed dialog has given it back to its opener.
    await new Promise((done) => setTimeout(done, 20));
    expect(document.activeElement).toBe(alert.parentElement);
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
  });

  it('shows the truth after a refusal: the row the job claimed moves to In progress', async () => {
    let claimed = false;
    serve(() =>
      pageOf(claimed ? [row(1, { status: 'executing', actions: [] }), row(2)] : [row(), row(2)]),
    );
    mount();
    await accountLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Cancel request…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this deletion request?' });
    typeReason(dialog);
    claimed = true;
    remove = () => failure(409, 'customers.account-deletion-in-progress');
    confirm(dialog);
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByText('In progress', { selector: 'span' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: `Actions for ${NAME}` })).toBeNull();
  });

  it('sends a signed-out admin away', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/settings' });
    const dialog = await openCancel();
    typeReason(dialog);
    remove = () => failure(401, 'session.invalid');
    confirm(dialog);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('Deletion requests list: review follow-ups', () => {
  const tick = async () => {
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${NAME}` }));
    expect(screen.getByText('1 request selected')).toBeTruthy();
  };
  const cleared = () => waitFor(() => expect(screen.queryByText('1 request selected')).toBeNull());

  it('drops the ticked rows when the sort or a filter changes', async () => {
    serve(() => pageOf([row()]));
    mount();
    await accountLink();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Requested' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('requested'));
    await cleared();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'requestedBy' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'admin' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastParams()['requestedBy']).toBe('admin'));
    await cleared();
  });

  it('selects all matching requests, exports them by the selector, and drops them for another view', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response('id\n1\n', { headers: { 'content-type': 'text/csv' } }),
        );
      }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    serve(() => pageOf([row()], { total: 30 }));
    mount();
    await accountLink();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 30 matching' }));
    expect(screen.getByText('All 30 matching requests are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/XLSX/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetched).toHaveLength(1));
    const params = Object.fromEntries(new URL(fetched[0]!, 'http://x').searchParams);
    expect(params['ids']).toBeUndefined();
    expect(params).toMatchObject({
      view: 'pending',
      sort: 'scheduled',
      direction: 'asc',
      format: 'xlsx',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled (12)' }));
    await waitFor(() =>
      expect(screen.queryByText('All 30 matching requests are selected')).toBeNull(),
    );
  });

  async function exportWith(response: Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response)),
    );
    serve(() => pageOf([row()]));
    mount();
    await accountLink();
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NAME}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
  }
  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('says when the file would be too large', async () => {
    await exportWith(json(413, { code: 'batch.too-large', details: { max: 10000, total: 12000 } }));
    expect(await screen.findByText(/Too many rows to export/)).toBeTruthy();
  });

  it('says when the export filters are refused', async () => {
    await exportWith(
      json(400, { code: 'validation.failed', details: { fields: [{ path: 'from' }] } }),
    );
    expect(await screen.findByText(/can't be exported with its current filters/)).toBeTruthy();
  });

  it('keeps the column choice for this viewer in storage, and drops an unknown stored id', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':deletion-requests-columns',
      JSON.stringify(['cancel-reason', 'nope']),
    );
    serve(() => pageOf([row(1, { status: 'cancelled', cancelReason: 'sign-in', actions: [] })]));
    mount({ view: 'cancelled' });
    await accountLink();
    expect(within(screen.getByRole('table')).getByText('Buyer signed in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Cancelled because' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(screen.getByRole('table')).queryByText('Buyer signed in')).toBeNull(),
    );
    expect(
      JSON.parse(window.localStorage.getItem('mp:admin:AU:' + ME + ':deletion-requests-columns')!),
    ).toEqual([]);
  });

  it('shows the times in the zone of the list, and keeps the column choice per Market', async () => {
    window.localStorage.setItem(
      'mp:admin:NZ:' + ME + ':deletion-requests-columns',
      JSON.stringify(['completed']),
    );
    // 21:30 on the 10th in Brisbane (UTC+10), already 00:30 on the 11th in Auckland (UTC+13).
    serve(() =>
      pageOf([
        row(1, {
          status: 'completed',
          actions: [],
          requestedAt: '2026-11-10T11:30:00.000Z',
          completedAt: '2026-12-10T11:30:00.000Z',
        }),
      ]),
    );
    mount({ zone: 'Pacific/Auckland', marketId: 'NZ', view: 'completed' });
    await screen.findByText(account(1));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Deleted' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Requested by' })).toBeNull();
    expect(within(table).getAllByText(/11 Nov/).length).toBeGreaterThan(0);
    expect(within(table).queryByText(/10 Nov/)).toBeNull();
    expect(screen.getByText('Dates are shown in Pacific/Auckland.')).toBeTruthy();
  });
});
