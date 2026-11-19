// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast, Toaster } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { cleanColumns } from './list/payouts-columns.ts';
import { exportParams } from './list/payouts-export.tsx';
import {
  DEFAULT_QUERY,
  filtersOf,
  type PayoutListPage,
  type PayoutListRow,
} from './list/payouts-list-types.ts';
import { payoutSearchRoute, queryString } from './list/payouts-query.ts';
import { PayoutsList } from './payouts-list.tsx';
import type { PayoutDetail } from './types.ts';

// The Payouts super list (list 21): views with counts, the one search box (payout id or store
// name), filters, sort, columns, both List paging modes, selection and Export, and the row
// Actions menu with its level 3 money actions (typed reference, then the step-up code).

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const PAYOUT = '0190a000-0000-7000-8000-0000000000a1';
const payoutId = (n: number) => `0190a000-0000-7000-8000-0000000000a${n}`;
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const HOLD = '0190a000-0000-7000-8000-0000000000e1';
const STORE = 'Cedar Lane Halal Meats';
const LIST = 'commission-payouts/admin/payouts';
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });

const row = (over: Partial<PayoutListRow> = {}): PayoutListRow => ({
  payoutId: PAYOUT,
  sellerId: SELLER,
  storeName: STORE,
  state: 'awaiting-approval',
  gross: aud('33000'),
  netted: aud('2000'),
  transfer: aud('31000'),
  approvalMode: 'MANUAL',
  approvalReason: 'first-payout',
  slotAt: '2026-11-17T00:00:00.000Z',
  outcomeCode: null,
  createdAt: '2026-11-15T23:00:00.000Z',
  stateChangedAt: '2026-11-15T23:00:00.000Z',
  activeHoldId: null,
  actions: ['open', 'approve', 'place-hold'],
  ...over,
});
const COUNTS = {
  all: 40,
  'awaiting-approval': 3,
  sending: 2,
  paid: 30,
  failed: 4,
  'not-sent': 1,
};
const pageOf = (payouts: PayoutListRow[], over: Partial<PayoutListPage> = {}): PayoutListPage => ({
  payouts,
  counts: COUNTS,
  total: payouts.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  searchCapped: false,
  ...over,
});
/** The answer of Previous and next: no total and no page. */
const openPage = (payouts: PayoutListRow[], nextCursor: string | null = null) =>
  pageOf(payouts, { total: null, page: null, nextCursor });

type Answer = PayoutListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string) =>
  Promise.resolve({ ok: false, failure: { status, code, details: { fields: [] } } } as never);

/** The list answers by URL; other calls (one payout, a decision) go to `other`. */
function serve(
  answer: (url: string) => Answer,
  other: (method: string, path: string, body?: unknown) => Promise<never> = () =>
    failure(404, 'not-found'),
) {
  call.mockImplementation((method, path, body) => {
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return other(method, path, body);
    const result = answer(path);
    if (result === 'fail') return failure(503, 'access.unavailable');
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
  options: {
    paging?: 'pages' | 'prev-next';
    sellerId?: string | null;
    initialView?: 'all' | 'awaiting-approval' | 'failed';
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StepUpProvider>
        <PayoutsList
          paging={options.paging ?? 'pages'}
          accountId="acc-1"
          marketId="AU"
          zone={BRISBANE}
          csrfToken="csrf-1"
          initialView={options.initialView ?? 'all'}
          sellerId={options.sellerId ?? null}
        />
      </StepUpProvider>
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
const rowMenu = async (name = `payout 000000A1 of ${STORE}`) => {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};
const menuLabels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent);

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
  toast.dismiss();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Payouts list: page numbers', () => {
  it('asks for page 1 of its view, newest first, and shows the views, the row and the range', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount({ initialView: 'awaiting-approval' });
    expect(await screen.findByRole('link', { name: 'Payout 000000A1' })).toBeTruthy();
    expect(lastParams()).toEqual({
      view: 'awaiting-approval',
      sort: 'created',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    });
    expect(
      screen.getByRole('button', { name: 'Awaiting approval (3)' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'All (40)' })).toBeTruthy();
    expect(screen.getByText('$310.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: STORE }).getAttribute('href')).toBe(
      `/sellers/${SELLER}`,
    );
    expect(screen.getByText('1-1 of 143')).toBeTruthy();
    // The All view sends no view key.
    fireEvent.click(screen.getByRole('button', { name: 'All (40)' }));
    await waitFor(() => expect(lastParams()['view']).toBeUndefined());
  });

  it('shows no button inside a row: every row action is in the Actions menu', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    const table = screen.getByRole('table', { name: 'Payouts' });
    const buttons = within(table)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual([`Actions for payout 000000A1 of ${STORE}`]);
  });

  it('lists exactly the actions the row names, in order, and ignores one it does not know', async () => {
    serve(() =>
      pageOf([
        row({ actions: ['place-hold', 'approve', 'open', 'refund'] }),
        row({
          payoutId: payoutId(2),
          state: 'approved',
          activeHoldId: HOLD,
          actions: ['open', 'release-hold'],
        }),
      ]),
    );
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    expect(menuLabels(await rowMenu())).toEqual(['Open', 'Approve…', 'Hold payouts…']);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(menuLabels(await rowMenu(`payout 000000A2 of ${STORE}`))).toEqual([
      'Open',
      'Release hold…',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith(`/payouts/${payoutId(2)}`);
  });

  it('routes the search: a full payout id is exact, other text is the store, one letter asks nothing', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: PAYOUT.toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(PAYOUT));
    expect(screen.getByText(`Payout ID is ${PAYOUT}`)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'cedar' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['search']).toBe('cedar'));
    expect(lastParams()['q']).toBeUndefined();
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

  it('starts on one seller from a link, as a chip that can be removed', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    expect(lastParams()['sellerId']).toBe(SELLER);
    fireEvent.click(screen.getByRole('button', { name: `Remove filter Seller is ${STORE}` }));
    await waitFor(() => expect(lastParams()['sellerId']).toBeUndefined());
  });

  it('sorts by the transfer, largest first, from the sort panel', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    expect(screen.getByText('Sorted by Created: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Transfer' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('amount'));
    expect(lastParams()['direction']).toBe('desc');
  });

  it('goes to page 2 and keeps the ticked rows of page 1', async () => {
    serve((url) =>
      url.includes('page=2')
        ? pageOf([row({ payoutId: payoutId(2) })], { total: 30, page: 2 })
        : pageOf([row()], { total: 30 }),
    );
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    fireEvent.click(screen.getByRole('checkbox', { name: `Select payout 000000A1 of ${STORE}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await screen.findByRole('link', { name: 'Payout 000000A2' })).toBeTruthy();
    expect(screen.getByText('1 payout selected')).toBeTruthy();
  });

  it('shows the empty state of the view, and a no-match state with Clear all', async () => {
    serve((url) => (url.includes('search=') ? pageOf([]) : pageOf([], { total: 0 })));
    mount({ initialView: 'failed' });
    expect(await screen.findByText('No payouts have failed')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'nobody' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('No payouts match')).toBeTruthy();
  });

  it('says the API refused the query without a Try again, and offers one when it is down', async () => {
    serve(() => 'refused');
    mount();
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
    serve(() => 'fail');
    mount();
    expect(await screen.findByText('The payouts could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Payout 000000A1' })).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to payouts.')).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/payouts' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('renders store names as plain text', async () => {
    serve(() => pageOf([row({ storeName: '<img src=x onerror=alert(1)>' })]));
    mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Payouts list: Previous and next', () => {
  it('sends limit and the cursor only, newest first, with no sort panel', async () => {
    serve((url) =>
      url.includes('cursor=')
        ? openPage([row({ payoutId: payoutId(2) })])
        : openPage([row()], `1700000000000.${PAYOUT}`),
    );
    mount({ paging: 'prev-next' });
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    expect(lastParams()).toEqual({ limit: '25' });
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
    expect(screen.getByText('Sorted by Created: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('link', { name: 'Payout 000000A2' })).toBeTruthy();
    expect(lastParams()).toEqual({ limit: '25', cursor: `1700000000000.${PAYOUT}` });
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(lastParams()).toEqual({ limit: '25' }));
  });
});

describe('Payouts list: money actions', () => {
  const detail = (over: Partial<PayoutDetail> = {}): PayoutDetail => ({
    ...row(),
    approval: null,
    items: [],
    accountReadiness: 'ready',
    lastBankChangeAt: null,
    limits: null,
    ...over,
  });
  const typeRef = (dialog: HTMLElement, label: string, text = '000000A1') =>
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value: text } });

  it('approves one payout after the reference is typed, then reads the list again', async () => {
    let approved = false;
    serve(
      () => pageOf([approved ? row({ state: 'approved', actions: ['open'] }) : row()]),
      (method, path) => {
        if (method === 'GET') return Promise.resolve({ ok: true, body: detail() } as never);
        approved = true;
        expect(path).toBe(`${LIST}/${PAYOUT}/approve`);
        return Promise.resolve({
          ok: true,
          body: {
            payoutId: PAYOUT,
            state: 'approved',
            transfer: aud('31000'),
            approvedBy: 'me',
            approvedAt: '2026-11-16T20:31:00.000Z',
          },
        } as never);
      },
    );
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    fireEvent.click(within(await rowMenu()).getByRole('menuitem', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve payout' });
    await within(dialog).findByText('Transfer');
    const button = within(dialog).getByRole('button', { name: 'Approve $310.00' });
    expect(button.hasAttribute('disabled')).toBe(true);
    typeRef(dialog, 'Type the payout reference to confirm');
    fireEvent.click(button);
    expect(await screen.findByText(/Approved \$310\.00 for Cedar Lane Halal Meats/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      `${LIST}/${PAYOUT}/approve`,
      { amountMinor: '31000' },
      'csrf-1',
    );
    await waitFor(() => expect(screen.getByText('Approved')).toBeTruthy());
  });

  it('places a hold on the whole seller: a reason, the typed reference, then the call', async () => {
    const posts: [string, unknown][] = [];
    serve(
      () => pageOf([row()]),
      (_method, path, body) => {
        posts.push([path, body]);
        return Promise.resolve({ ok: true, body: {} } as never);
      },
    );
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    fireEvent.click(within(await rowMenu()).getByRole('menuitem', { name: 'Hold payouts…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hold payouts for payout 000000A1?' });
    expect(within(dialog).getByText(/All payouts of Cedar Lane Halal Meats stop/)).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Cancel');
    const place = within(dialog).getByRole('button', { name: 'Place hold' });
    typeRef(dialog, 'Type the payout reference to confirm');
    // No reason yet: Confirm stays off.
    expect(place.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'admin-review' },
    });
    expect(place.hasAttribute('disabled')).toBe(false);
    fireEvent.click(place);
    expect(await screen.findByText(/Hold placed/)).toBeTruthy();
    expect(posts).toEqual([
      [`commission-payouts/admin/sellers/${SELLER}/payout-holds`, { reason: 'admin-review' }],
    ]);
  });

  it('releases the seller hold named by the row, and shows a refusal in the dialog', async () => {
    serve(
      () => pageOf([row({ activeHoldId: HOLD, actions: ['open', 'release-hold'] })]),
      () => failure(409, 'commission-payouts.hold-already-released'),
    );
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    fireEvent.click(within(await rowMenu()).getByRole('menuitem', { name: 'Release hold…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Release the hold on payout 000000A1?',
    });
    fireEvent.change(within(dialog).getByLabelText('Reason for releasing'), {
      target: { value: 'review-complete' },
    });
    typeRef(dialog, 'Type the payout reference to confirm', '000000A9');
    const release = within(dialog).getByRole('button', { name: 'Release hold' });
    expect(release.hasAttribute('disabled')).toBe(true);
    typeRef(dialog, 'Type the payout reference to confirm');
    fireEvent.click(release);
    expect(await within(dialog).findByText(/already released/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      `commission-payouts/admin/payout-holds/${HOLD}/release`,
      { reason: 'review-complete' },
      'csrf-1',
    );
  });
});

describe('Payouts list: queries and export', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('builds the list query of page numbers and of Previous and next', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'failed' as const,
      q: 'cedar',
      filters: { approvalMode: 'MANUAL' as const, created: 'today' as const },
      sort: 'amount' as const,
      direction: 'asc' as const,
      page: 3,
    };
    expect(Object.fromEntries(new URLSearchParams(queryString(query, context)))).toEqual({
      view: 'failed',
      search: 'cedar',
      approvalMode: 'MANUAL',
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
  });

  it('routes the search box text', () => {
    expect(payoutSearchRoute('  ')).toEqual({ kind: 'none' });
    expect(payoutSearchRoute('x')).toEqual({ kind: 'too-short' });
    expect(payoutSearchRoute(PAYOUT.toUpperCase())).toEqual({ kind: 'id', value: PAYOUT });
    expect(payoutSearchRoute(' Cedar ')).toEqual({ kind: 'store', value: 'Cedar' });
  });

  it('keeps only known filters and known columns', () => {
    expect(filtersOf({ approvalMode: 'NEVER', created: 'last-7-days' })).toEqual({
      created: 'last-7-days',
    });
    expect(cleanColumns(['outcome', 'nope', 'gross'])).toEqual(['outcome', 'gross']);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: 'cedar', sort: 'slot' as const };
    expect(
      Object.fromEntries(
        new URLSearchParams(
          exportParams({
            query,
            paging: 'pages',
            zone: BRISBANE,
            format: 'csv',
            columns: ['gross', 'seller-id'],
            selection: { ids: [PAYOUT, payoutId(2)], allMatching: false, total: 30 },
          }),
        ),
      ),
    ).toEqual({ ids: `${PAYOUT},${payoutId(2)}`, format: 'csv', columns: 'gross,seller-id' });
    expect(
      Object.fromEntries(
        new URLSearchParams(
          exportParams({
            query,
            paging: 'prev-next',
            zone: BRISBANE,
            format: 'xlsx',
            columns: [],
            selection: { ids: [], allMatching: true, total: null },
          }),
        ),
      ),
    ).toEqual({ search: 'cedar', sort: 'created', direction: 'desc', format: 'xlsx' });
  });

  it('downloads the file of the ticked rows from the Bulk action menu', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response('payout id\n1\n', { headers: { 'content-type': 'text/csv' } }),
        );
      }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    serve(() => pageOf([row()]));
    mount();
    await screen.findByRole('link', { name: 'Payout 000000A1' });
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: `Select payout 000000A1 of ${STORE}` }));
    fireEvent.click(bulk);
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetched).toHaveLength(1));
    const url = new URL(fetched[0]!, 'http://x');
    expect(url.pathname).toBe('/api/commission-payouts/admin/payouts/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: PAYOUT,
      format: 'csv',
      columns: 'approval-reason,slot',
    });
  });
});
