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
import { DisputesList } from './disputes-list.tsx';
import { cleanColumns } from './list/disputes-columns.ts';
import { exportParams } from './list/disputes-export.tsx';
import {
  DEFAULT_QUERY,
  dueBeforeOf,
  filtersOf,
  type DisputeListPage,
  type DisputeListRow,
} from './list/disputes-list-types.ts';
import { disputeSearchRoute, queryString } from './list/disputes-query.ts';

// The Disputes super list (list 23): views with counts, the one search box (dispute or order id,
// or a store name), filters, sort, columns, both List paging modes, selection and Export, and the
// row Actions menu (Open, Decide: both open the case's page).

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const DISPUTE = '0190a000-0000-7000-8000-000000000d01';
const disputeId = (n: number) => `0190a000-0000-7000-8000-000000000d0${n}`;
const ORDER = '0190a000-0000-7000-8000-0000000000a1';
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const STORE = 'Cedar Lane Halal Meats';
const LIST = 'commission-payouts/admin/disputes';
const NAME = `case 000000A1 of ${STORE}`;

const row = (over: Partial<DisputeListRow> = {}): DisputeListRow => ({
  disputeId: DISPUTE,
  orderId: ORDER,
  sellers: [{ sellerId: SELLER, storeName: STORE }],
  reason: 'product_not_received',
  moneyState: 'withdrawn',
  status: 'needs_response',
  bucket: 'needs-response',
  evidenceDueBy: '2026-11-19T10:00:00.000Z',
  amount: { amountMinor: '12500', currency: 'AUD' },
  openedAt: '2026-11-10T01:00:00.000Z',
  updatedAt: '2026-11-11T01:00:00.000Z',
  actions: ['open'],
  ...over,
});
const COUNTS = {
  all: 40,
  'needs-response': 2,
  'decision-needed': 1,
  'under-review': 5,
  won: 12,
  closed: 20,
};
const pageOf = (
  disputes: DisputeListRow[],
  over: Partial<DisputeListPage> = {},
): DisputeListPage => ({
  disputes,
  counts: COUNTS,
  total: disputes.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  searchCapped: false,
  ...over,
});
/** The answer of Previous and next: no total and no page. */
const openPage = (disputes: DisputeListRow[], nextCursor: string | null = null) =>
  pageOf(disputes, { total: null, page: null, nextCursor });

type Answer = DisputeListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string) =>
  Promise.resolve({ ok: false, failure: { status, code, details: { fields: [] } } } as never);

function serve(answer: (url: string) => Answer) {
  call.mockImplementation((method, path) => {
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return failure(404, 'not-found');
    const result = answer(path);
    if (result === 'fail') return failure(503, 'commission-payouts.search-unavailable');
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

function mount(
  options: { paging?: 'pages' | 'prev-next'; sellerId?: string | null; view?: 'all' | 'won' } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <DisputesList
        paging={options.paging ?? 'pages'}
        accountId="acc-1"
        marketId="AU"
        zone={BRISBANE}
        initialView={options.view ?? 'all'}
        sellerId={options.sellerId ?? null}
      />
    </NextIntlClientProvider>,
  );
}
const caseLink = (n = 1) =>
  screen.findByRole('link', { name: `Order 000000A${n === 1 ? '1' : String(n)}` });

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

describe('Disputes list: page numbers', () => {
  it('asks for page 1, newest opened first, and shows the views, the row and the range', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    const link = await caseLink();
    expect(link.getAttribute('href')).toBe(`/disputes/${DISPUTE}`);
    expect(lastParams()).toEqual({ sort: 'opened', direction: 'desc', page: '1', pageSize: '25' });
    expect(screen.getByRole('button', { name: 'All (40)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('Needs response')).toBeTruthy();
    expect(within(table).getByText(STORE)).toBeTruthy();
    expect(within(table).getByText('$125.00')).toBeTruthy();
    expect(within(table).getByText('Taken by bank')).toBeTruthy();
    expect(screen.getByText('1–1 of 143 cases')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decision needed (1)' }));
    await waitFor(() => expect(lastParams()['view']).toBe('decision-needed'));
  });

  it('has no button in a row; its menu offers the actions the row names and opens the case', async () => {
    serve(() => pageOf([row({ actions: ['decide', 'open', 'refund'] })]));
    mount();
    await caseLink();
    const buttons = within(screen.getByRole('table'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual([`Actions for ${NAME}`]);
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${NAME}` }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open', "Decide on the case's page"]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: "Decide on the case's page" }));
    expect(push).toHaveBeenCalledWith(`/disputes/${DISPUTE}`);
  });

  it('sends an id as q and a store name as search; one letter asks nothing', async () => {
    serve(() => pageOf([row()]));
    mount();
    await caseLink();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: ORDER.toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(ORDER));
    expect(screen.getByText(`Dispute or order ID is ${ORDER}`)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'cedar\tlane' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // A pasted tab is a space: the API takes printable text.
    await waitFor(() => expect(lastParams()['search']).toBe('cedar lane'));
    expect(lastParams()['q']).toBeUndefined();
    const before = listUrls().length;
    fireEvent.change(box, { target: { value: 'c' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Type at least 2 characters/)).toBeTruthy();
    expect(listUrls()).toHaveLength(before);
  });

  it('starts on one seller from a link, as a chip that can be removed', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await caseLink();
    expect(lastParams()['sellerId']).toBe(SELLER);
    fireEvent.click(screen.getByRole('button', { name: `Remove filter Seller is ${STORE}` }));
    await waitFor(() => expect(lastParams()['sellerId']).toBeUndefined());
  });

  it('filters from the panel and shows the filter as a removable chip', async () => {
    serve(() => pageOf([row()], { total: 7 }));
    mount();
    await caseLink();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'money' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'reinstated' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastParams()['money']).toBe('reinstated'));
    expect(screen.getByText('7 cases match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Money is Returned to us' }));
    await waitFor(() => expect(lastParams()['money']).toBeUndefined());
  });

  it('sorts by the evidence deadline, nearest first', async () => {
    serve(() => pageOf([row()]));
    mount();
    await caseLink();
    expect(screen.getByText('Sorted by Opened: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Evidence due' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('evidence-due'));
    expect(lastParams()['direction']).toBe('asc');
  });

  it('keeps the ticked rows over paging, and drops them for another view or search', async () => {
    serve((url) =>
      url.includes('page=2')
        ? pageOf([row({ disputeId: disputeId(2), orderId: `${ORDER.slice(0, -2)}a2` })], {
            total: 30,
            page: 2,
          })
        : pageOf([row()], { total: 30 }),
    );
    mount();
    await caseLink();
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NAME}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await caseLink(2)).toBeTruthy();
    expect(screen.getByText('1 case selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Won (12)' }));
    await waitFor(() => expect(screen.queryByText('1 case selected')).toBeNull());
  });

  it('goes back to the last page with rows when a page is past the end', async () => {
    serve((url) => {
      if (url.includes('page=4')) return pageOf([], { total: 30, page: 4 });
      if (url.includes('page=2'))
        return pageOf([row({ disputeId: disputeId(2), orderId: `${ORDER.slice(0, -2)}a2` })], {
          total: 30,
          page: 2,
        });
      return pageOf([row()], { total: 90 });
    });
    mount();
    await caseLink();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(await caseLink(2)).toBeTruthy();
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
    expect(await screen.findByText('The disputes could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await caseLink()).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to disputes.')).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/disputes' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the empty state of a view, and a no-match state with Clear all', async () => {
    serve((url) => (url.includes('search=') ? pageOf([]) : pageOf([], { total: 0 })));
    mount({ view: 'won' });
    expect(await screen.findByText('No disputes won yet')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'nobody' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('No disputes match')).toBeTruthy();
  });

  it('renders store names as plain text', async () => {
    serve(() =>
      pageOf([row({ sellers: [{ sellerId: SELLER, storeName: '<img src=x onerror=alert(1)>' }] })]),
    );
    mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Disputes list: Previous and next', () => {
  it('sends limit and the cursor only, newest first, and steps Next, Next, Previous', async () => {
    serve((url) => {
      if (url.includes('cursor=c2'))
        return openPage([row({ disputeId: disputeId(3), orderId: `${ORDER.slice(0, -2)}a3` })]);
      if (url.includes('cursor=c1'))
        return openPage(
          [row({ disputeId: disputeId(2), orderId: `${ORDER.slice(0, -2)}a2` })],
          'c2',
        );
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await caseLink();
    expect(lastParams()).toEqual({ limit: '25' });
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await caseLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await caseLink(3);
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c2' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await caseLink(2)).toBeTruthy();
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c1' });
  });

  it('steps back once when a page comes back empty', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([]);
      if (url.includes('cursor=c1'))
        return openPage(
          [row({ disputeId: disputeId(2), orderId: `${ORDER.slice(0, -2)}a2` })],
          'c2',
        );
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await caseLink();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await caseLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listUrls()).toHaveLength(4));
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c1' });
  });
});

describe('Disputes list: queries and export', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('builds the list query with every filter', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'closed' as const,
      q: 'cedar',
      sellerId: SELLER,
      filters: {
        status: 'lost' as const,
        money: 'withdrawn' as const,
        evidenceDue: 'next-3-days' as const,
        opened: 'today' as const,
      },
      sort: 'amount' as const,
      direction: 'asc' as const,
      page: 3,
    };
    expect(Object.fromEntries(new URLSearchParams(queryString(query, context)))).toEqual({
      view: 'closed',
      search: 'cedar',
      sellerId: SELLER,
      status: 'lost',
      money: 'withdrawn',
      dueBefore: '2026-11-19T20:30:00.000Z',
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
    ).toBe('limit=25&cursor=b');
    expect(dueBeforeOf('overdue', NOW)).toBe(NOW.toISOString());
  });

  it('routes the search box text, and keeps only known filters and columns', () => {
    expect(disputeSearchRoute('  ')).toEqual({ kind: 'none' });
    expect(disputeSearchRoute('x')).toEqual({ kind: 'too-short' });
    expect(disputeSearchRoute(DISPUTE.toUpperCase())).toEqual({ kind: 'id', value: DISPUTE });
    expect(disputeSearchRoute(' Cedar\nLane ')).toEqual({ kind: 'store', value: 'Cedar Lane' });
    expect(filtersOf({ status: 'lost', money: 'gone', evidenceDue: 'overdue' })).toEqual({
      status: 'lost',
      evidenceDue: 'overdue',
    });
    expect(cleanColumns(['updated', 'nope', 'seller-ids'])).toEqual(['updated', 'seller-ids']);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: 'cedar', sort: 'amount' as const };
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
        columns: ['reason', 'seller-ids'],
        selection: { ids: [DISPUTE, disputeId(2)], allMatching: false, total: 30 },
      }),
    ).toEqual({ ids: `${DISPUTE},${disputeId(2)}`, format: 'csv', columns: 'reason,seller-ids' });
    expect(
      params({
        paging: 'prev-next',
        format: 'xlsx',
        selection: { ids: [], allMatching: true, total: null },
      }),
    ).toEqual({ search: 'cedar', sort: 'opened', direction: 'desc', format: 'xlsx' });
  });

  it('downloads the file of the ticked rows from the Bulk action menu', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response('case\n1\n', { headers: { 'content-type': 'text/csv' } }),
        );
      }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    serve(() => pageOf([row()]));
    mount();
    await caseLink();
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NAME}` }));
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
    expect(url.pathname).toBe('/api/commission-payouts/admin/disputes/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: DISPUTE,
      format: 'csv',
      columns: 'money,reason,evidence-due',
    });
  });
});
