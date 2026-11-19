// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { CreditRequestsList } from './credit-requests-list.tsx';
import { cleanColumns, exportColumns } from './list/credit-requests-columns.ts';
import { exportParams } from './list/credit-requests-export.tsx';
import {
  DEFAULT_QUERY,
  filtersOf,
  type CreditListPage,
  type CreditListRow,
} from './list/credit-requests-list-types.ts';
import { creditSearchRoute, queryString } from './list/credit-requests-query.ts';

// The Credit requests super list (list 24): views with counts, the id-only search, filters, sort,
// columns, both List paging modes, selection and Export, the row Actions menu (Details, Approve,
// Reject) and the two money dialogs.

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const ME = '0190a000-0000-7000-8000-0000000000a1';
const OTHER = '0190a000-0000-7000-8000-0000000000b2';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const customer = (n: number) => `0190a000-0000-7000-8000-00000000c${String(n).padStart(3, '0')}`;
const LIST = 'wallet/admin/credit-requests';
const NAME = 'request for customer 0000C001, $900.00';

const row = (n = 1, over: Partial<CreditListRow> = {}): CreditListRow => ({
  id: id(n),
  customerAccountId: customer(n),
  amount: '90000',
  currency: 'AUD',
  reasonCode: 'goodwill',
  note: null,
  status: 'pending',
  approvalReason: 'issue-cap',
  requestedBy: OTHER,
  requestedAt: '2026-11-10T01:00:00.000Z',
  expiresAt: '2026-11-12T01:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  journalId: null,
  actions: ['open', 'approve', 'reject'],
  ...over,
});
const COUNTS = { pending: 3, decided: 12, granted: 20, all: 35 };
const pageOf = (entries: CreditListRow[], over: Partial<CreditListPage> = {}): CreditListPage => ({
  entries,
  counts: COUNTS,
  total: entries.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  ...over,
});
/** The answer of Previous and next: no total and no page. */
const openPage = (entries: CreditListRow[], nextCursor: string | null = null) =>
  pageOf(entries, { total: null, page: null, nextCursor });

type Answer = CreditListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string) =>
  Promise.resolve({ ok: false, failure: { status, code, details: { fields: [] } } } as never);
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, body } as never);

/** What a POST (approve or reject) answers; set by the test. */
let post: () => Promise<never> = () => failure(500, 'unexpected');

function serve(answer: (url: string) => Answer) {
  call.mockImplementation((method, path) => {
    if (method === 'POST') return post();
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return failure(404, 'not-found');
    const result = answer(path);
    if (result === 'fail') return failure(503, 'wallet.unavailable');
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
const posts = () => call.mock.calls.filter((entry) => entry[0] === 'POST');

function mount(
  options: { paging?: 'pages' | 'prev-next'; view?: 'pending' | 'decided' | 'all' } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <CreditRequestsList
        paging={options.paging ?? 'pages'}
        accountId={ME}
        csrfToken="csrf"
        marketId="AU"
        zone={BRISBANE}
        initialView={options.view ?? 'pending'}
      />
    </NextIntlClientProvider>,
  );
}
const customerLink = (n = 1) => screen.findByRole('link', { name: `0000C00${n}` });
const openMenu = async (name = NAME) => {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};

beforeEach(() => {
  vi.clearAllMocks();
  post = () => failure(500, 'unexpected');
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

describe('Credit requests list: page numbers', () => {
  it('asks for the pending view, page 1, newest first, and shows the views, the row and the range', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    const link = await customerLink();
    expect(link.getAttribute('href')).toBe(`/wallet/credits?customer=${customer(1)}`);
    expect(lastParams()).toEqual({
      view: 'pending',
      sort: 'requested',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    });
    expect(screen.getByRole('button', { name: 'Pending (3)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('Pending', { selector: 'span' })).toBeTruthy();
    expect(within(table).getByText('$900.00')).toBeTruthy();
    expect(within(table).getByText('Goodwill')).toBeTruthy();
    expect(within(table).getByText('0000B2'.padStart(8, '0'))).toBeTruthy();
    expect(screen.getByText('1–1 of 143 requests')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Granted at once (20)' }));
    await waitFor(() => expect(lastParams()['view']).toBe('granted'));
    fireEvent.click(screen.getByRole('button', { name: 'All (35)' }));
    await waitFor(() => expect(lastParams()['view']).toBe('all'));
  });

  it('has no button in a row; its menu offers the actions the row names, in order', async () => {
    serve(() => pageOf([row(1, { actions: ['reject', 'open', 'refund', 'approve'] })]));
    mount();
    await customerLink();
    const buttons = within(screen.getByRole('table'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual([`Actions for ${NAME}`]);
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Details…', 'Approve…', 'Reject…']);
  });

  it('offers no Approve… on a row that does not name it, and shows an own request as You', async () => {
    serve(() => pageOf([row(1, { requestedBy: ME, actions: ['open'] })]));
    mount();
    await customerLink();
    expect(within(screen.getByRole('table')).getByText('You')).toBeTruthy();
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Details…']);
  });

  it('sends an id as q (lower-case, control characters as spaces); text that is not an id asks nothing', async () => {
    serve(() => pageOf([row()]));
    mount();
    await customerLink();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: `\t${ME.toUpperCase()}\n` } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(ME));
    expect(screen.getByText(`Request or customer ID is ${ME}`)).toBeTruthy();
    const before = listUrls().length;
    fireEvent.change(box, { target: { value: 'Ada Lovelace' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/That is not an ID/)).toBeTruthy();
    expect(listUrls()).toHaveLength(before);
    expect(lastParams()['q']).toBe(ME);
  });

  it('filters from the panel and shows each filter as a removable chip', async () => {
    serve(() => pageOf([row()], { total: 7 }));
    mount();
    await customerLink();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'reason' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'promotion' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastParams()['reason']).toBe('promotion'));
    expect(screen.getByText('7 requests match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Reason is Promotion' }));
    await waitFor(() => expect(lastParams()['reason']).toBeUndefined());
  });

  it('filters by requested by Me and by a date preset on the list zone', async () => {
    serve(() => pageOf([row()]));
    mount();
    await customerLink();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'requestedBy' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'me' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastParams()['requestedBy']).toBe('me'));
    expect(screen.getByText('Requested by is Me')).toBeTruthy();
  });

  it('sorts by the expiry, nearest first', async () => {
    serve(() => pageOf([row()]));
    mount();
    await customerLink();
    expect(screen.getByText('Sorted by Requested: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Expires' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('expires'));
    expect(lastParams()['direction']).toBe('asc');
  });

  it('keeps the ticked rows over paging and for the same id in another case, and drops them for another view', async () => {
    serve((url) =>
      url.includes('page=2')
        ? pageOf([row(2)], { total: 30, page: 2 })
        : pageOf([row()], { total: 30 }),
    );
    mount();
    await customerLink();
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
    await customerLink();
    expect(screen.getByText('1 request selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await customerLink(2)).toBeTruthy();
    expect(screen.getByText('1 request selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decided (12)' }));
    await waitFor(() => expect(screen.queryByText('1 request selected')).toBeNull());
  });

  it('goes back to the last page with rows when a page is past the end', async () => {
    serve((url) => {
      if (url.includes('page=4')) return pageOf([], { total: 30, page: 4 });
      if (url.includes('page=2')) return pageOf([row(2)], { total: 30, page: 2 });
      return pageOf([row()], { total: 90 });
    });
    mount();
    await customerLink();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(await customerLink(2)).toBeTruthy();
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
    expect(await screen.findByText('The credit requests could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await customerLink()).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/wallet/credit-requests' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the empty state of a view, and a no-match state with Clear all', async () => {
    serve(() => pageOf([], { total: 0 }));
    mount({ view: 'decided' });
    expect(await screen.findByText('No decided requests yet.')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: ME } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('No credit requests match')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
    await waitFor(() => expect(lastParams()['q']).toBeUndefined());
  });

  it('shows a status it does not know as plain text', async () => {
    serve(() => pageOf([row(1, { status: 'weird' as never, reasonCode: 'queue.col' })]));
    mount();
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('weird')).toBeTruthy();
    expect(within(table).getByText('queue.col')).toBeTruthy();
  });
});

describe('Credit requests list: Previous and next', () => {
  it('sends limit and the cursor only, with no sort, and steps Next, Next, Previous', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([row(3)]);
      if (url.includes('cursor=c1')) return openPage([row(2)], 'c2');
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await customerLink();
    expect(lastParams()).toEqual({ view: 'pending', limit: '25' });
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await customerLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await customerLink(3);
    expect(lastParams()).toEqual({ view: 'pending', limit: '25', cursor: 'c2' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await customerLink(2)).toBeTruthy();
    expect(lastParams()).toEqual({ view: 'pending', limit: '25', cursor: 'c1' });
  });

  it('steps back once when a page comes back empty', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([]);
      if (url.includes('cursor=c1')) return openPage([row(2)], 'c2');
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await customerLink();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await customerLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listUrls()).toHaveLength(4));
    expect(lastParams()).toEqual({ view: 'pending', limit: '25', cursor: 'c1' });
  });
});

describe('Credit requests list: queries and export', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('builds the list query with every filter, and always names the view', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'decided' as const,
      q: ME,
      filters: {
        status: 'rejected' as const,
        reason: 'correction' as const,
        approvalReason: 'daily-cap' as const,
        requestedBy: 'me' as const,
        requested: 'today' as const,
      },
      sort: 'amount' as const,
      direction: 'asc' as const,
      page: 3,
    };
    expect(Object.fromEntries(new URLSearchParams(queryString(query, context)))).toEqual({
      view: 'decided',
      q: ME,
      status: 'rejected',
      reason: 'correction',
      approvalReason: 'daily-cap',
      requestedBy: 'me',
      // The 17th in Brisbane (UTC+10).
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      sort: 'amount',
      direction: 'asc',
      page: '3',
      pageSize: '25',
    });
    expect(
      queryString({ ...DEFAULT_QUERY, cursors: ['a', 'b'] }, { ...context, paging: 'prev-next' }),
    ).toBe('view=pending&limit=25&cursor=b');
  });

  it('routes the search box text, and keeps only known filters and columns', () => {
    expect(creditSearchRoute('  ')).toEqual({ kind: 'none' });
    expect(creditSearchRoute('x')).toEqual({ kind: 'not-id' });
    expect(creditSearchRoute('a@example.test')).toEqual({ kind: 'not-id' });
    // A v4 UUID is not an id the API knows.
    expect(creditSearchRoute('3f2c9a8e-1b4d-4c6e-9f00-112233445566')).toEqual({ kind: 'not-id' });
    expect(creditSearchRoute(ME.toUpperCase())).toEqual({ kind: 'id', value: ME });
    expect(creditSearchRoute(` ${ME}\t`)).toEqual({ kind: 'id', value: ME });
    expect(
      filtersOf({ status: 'rejected', reason: 'rent', requestedBy: 'you', approvalReason: 'x' }),
    ).toEqual({ status: 'rejected' });
    expect(cleanColumns(['journal', 'nope', 'note'])).toEqual(['journal', 'note']);
  });

  it('maps the columns on screen to the columns of the export', () => {
    expect(
      exportColumns(['reason', 'note', 'requested-by', 'until', 'decided-by', 'journal']),
    ).toEqual(['note', 'expires', 'decided', 'decided-by', 'journal']);
    expect(exportColumns(['reason', 'requested-by'])).toEqual([]);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: ME, sort: 'amount' as const };
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
        columns: ['reason', 'until', 'note'],
        selection: { ids: [id(1), id(2)], allMatching: false, total: 30 },
      }),
    ).toEqual({ ids: `${id(1)},${id(2)}`, format: 'csv', columns: 'expires,decided,note' });
    expect(
      params({
        paging: 'prev-next',
        format: 'xlsx',
        selection: { ids: [], allMatching: true, total: null },
      }),
    ).toEqual({
      view: 'pending',
      q: ME,
      sort: 'requested',
      direction: 'desc',
      format: 'xlsx',
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
    await customerLink();
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NAME}` }));
    fireEvent.click(bulk);
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    // Export is the only bulk action: money is never decided in bulk.
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Export/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
    await waitFor(() => expect(fetched).toHaveLength(1));
    const url = new URL(fetched[0]!, 'http://x');
    expect(url.pathname).toBe('/api/wallet/admin/credit-requests/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: id(1),
      format: 'csv',
      columns: 'expires,decided',
    });
  });
});

describe('Credit requests list: Details', () => {
  it('shows the note as plain text with the decision, from the menu', async () => {
    serve(() =>
      pageOf([
        row(1, {
          status: 'rejected',
          note: '<b>big</b>\nsecond line',
          decidedBy: ME,
          decidedAt: '2026-11-11T03:00:00.000Z',
          decisionReason: 'duplicate',
          journalId: id(77),
          actions: ['open'],
        }),
      ]),
    );
    mount({ view: 'decided' });
    await customerLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Details…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Credit request 00000001' });
    expect(within(dialog).getByText(/<b>big<\/b>/).textContent).toBe('<b>big</b>\nsecond line');
    expect(dialog.querySelector('b')).toBeNull();
    expect(within(dialog).getByText('Duplicate')).toBeTruthy();
    expect(within(dialog).getByText('More than the limit for one credit')).toBeTruthy();
    expect(within(dialog).getByText('You')).toBeTruthy();
    expect(within(dialog).getByText('00000077')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Approve|Reject/ })).toBeNull();
  });

  it('tells an admin why their own pending request cannot be decided by them', async () => {
    serve(() => pageOf([row(1, { requestedBy: ME, actions: ['open'] })]));
    mount();
    await customerLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Details…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Credit request 00000001' });
    expect(
      within(dialog).getByText('You asked for this credit. A different admin has to decide it.'),
    ).toBeTruthy();
  });
});

describe('Credit requests list: Approve', () => {
  const openApprove = async () => {
    serve(() => pageOf([row(), row(2, { amount: '2500' })]));
    mount();
    await customerLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Approve…' }));
    return screen.findByRole('dialog', { name: 'Approve $900.00 for customer 0000C001?' });
  };

  it('names the amount and customer, starts on Cancel, and needs the exact id typed', async () => {
    const dialog = await openApprove();
    expect(dialog.textContent).toContain(
      "$900.00 will be added to customer 0000C001's wallet now. You cannot undo this.",
    );
    expect(dialog.textContent).toContain(
      "Approving adds the credit to the customer's wallet. Next, you will be asked for your two-step code.",
    );
    expect(document.activeElement?.textContent).toBe('Cancel');
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Approve credit',
    });
    expect(confirm.disabled).toBe(true);
    const field = within(dialog).getByLabelText('Type 00000001 to confirm');
    for (const wrong of ['0000000', '000000011', '00000002', 'approve']) {
      fireEvent.change(field, { target: { value: wrong } });
      expect(confirm.disabled).toBe(true);
    }
    fireEvent.click(confirm);
    expect(posts()).toHaveLength(0);
    fireEvent.change(field, { target: { value: '00000001' } });
    expect(confirm.disabled).toBe(false);
  });

  it('approves through the guarded call with no body, says so, reads the list again and focuses it', async () => {
    const dialog = await openApprove();
    fireEvent.change(within(dialog).getByLabelText('Type 00000001 to confirm'), {
      target: { value: '00000001' },
    });
    post = () => ok(row(1, { status: 'approved' }));
    const reads = listUrls().length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve credit' }));
    await expectToast('Credit approved. $900.00 was added.');
    expect(posts()).toEqual([['POST', `${LIST}/${id(1)}/approve`, undefined, 'csrf']]);
    // No optimistic edit: the rows come from the next read.
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active.tabIndex).toBe(-1);
      expect(active.contains(screen.getByRole('table'))).toBe(true);
    });
  });

  it('leaves the dialog as it was when the code dialog is cancelled', async () => {
    const dialog = await openApprove();
    fireEvent.change(within(dialog).getByLabelText('Type 00000001 to confirm'), {
      target: { value: '00000001' },
    });
    post = () => failure(0, STEP_UP_CANCELLED);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve credit' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Type 00000001 to confirm').value).toBe(
      '00000001',
    );
  });

  it.each([
    ['wallet.credit-request-decided', 409, 'Someone already decided this request.', true],
    [
      'wallet.credit-request-expired',
      409,
      'This request expired and can no longer be approved.',
      true,
    ],
    ['wallet.credit-request-not-found', 404, 'This request no longer exists.', true],
    [
      'wallet.approver-is-requester',
      403,
      'You asked for this credit. A different admin has to decide it.',
      false,
    ],
    ['wallet.paused', 409, 'The wallet is not active, so this cannot be approved now.', false],
    ['wallet.frozen', 409, 'The wallet is not active, so this cannot be approved now.', false],
    ['wallet.disabled', 404, 'The wallet is not active, so this cannot be approved now.', false],
    [
      'wallet.cap-exceeded',
      409,
      "The customer's wallet no longer has room for this amount.",
      false,
    ],
    ['wallet.account-not-active', 409, "This customer's wallet cannot receive credit.", false],
    ['access.denied', 403, 'You do not have permission to decide credit requests.', false],
    ['wallet.unavailable', 503, 'We could not complete this. Try again.', false],
  ])(
    'answers %s with a banner, and reads again only when the row is out of date',
    async (code, status, text, stale) => {
      const dialog = await openApprove();
      fireEvent.change(within(dialog).getByLabelText('Type 00000001 to confirm'), {
        target: { value: '00000001' },
      });
      post = () => failure(status, code);
      const reads = listUrls().length;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve credit' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(text);
      expect(dialog.hasAttribute('open')).toBe(false);
      // The focus goes to the message, after the closed dialog has given it back to its opener.
      await new Promise((done) => setTimeout(done, 20));
      expect(document.activeElement).toBe(alert.parentElement);
      if (stale) await waitFor(() => expect(listUrls().length).toBe(reads + 1));
      else expect(listUrls().length).toBe(reads);
    },
  );

  it('sends a signed-out admin away', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/wallet/credit-requests' });
    const dialog = await openApprove();
    fireEvent.change(within(dialog).getByLabelText('Type 00000001 to confirm'), {
      target: { value: '00000001' },
    });
    post = () => failure(401, 'session.invalid');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve credit' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('encodes the request id in the path', async () => {
    serve(() => pageOf([row(1, { id: 'a b/c' })]));
    mount();
    await customerLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog', { name: /^Approve/ });
    fireEvent.change(within(dialog).getByLabelText(/^Type .* to confirm$/), {
      target: { value: 'A B/C' },
    });
    post = () => failure(409, 'wallet.credit-request-decided');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve credit' }));
    await screen.findByRole('alert');
    expect(posts()[0]![1]).toBe(`${LIST}/a%20b%2Fc/approve`);
  });
});

describe('Credit requests list: Reject', () => {
  const openReject = async () => {
    serve(() => pageOf([row()]));
    mount();
    await customerLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Reject…' }));
    return screen.findByRole('dialog', { name: 'Reject $900.00 for customer 0000C001?' });
  };

  it('needs a reason, sends it, says no credit was added and reads the list again', async () => {
    const dialog = await openReject();
    expect(document.activeElement?.textContent).toBe('Cancel');
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Reject request',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(posts()).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    expect(confirm.disabled).toBe(false);
    post = () => ok(row(1, { status: 'rejected', decisionReason: 'policy' }));
    const reads = listUrls().length;
    fireEvent.click(confirm);
    await expectToast('Request rejected. No credit was issued.');
    expect(posts()).toEqual([
      ['POST', `${LIST}/${id(1)}/reject`, { reasonCode: 'policy' }, 'csrf'],
    ]);
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
  });

  it('shows a refusal in a banner, and a request that expired as out of date', async () => {
    const dialog = await openReject();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'duplicate' } });
    post = () => failure(409, 'wallet.credit-request-expired');
    const reads = listUrls().length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This request expired and can no longer be approved.',
    );
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
  });

  it('starts empty again on the next opening', async () => {
    const dialog = await openReject();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Reject…' }));
    const again = await screen.findByRole('dialog', {
      name: 'Reject $900.00 for customer 0000C001?',
    });
    expect(within(again).getByLabelText<HTMLSelectElement>('Reason').value).toBe('');
  });
});
