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
import { cleanColumns, exportColumns } from './holds/holds-columns.ts';
import { exportParams } from './holds/holds-export.tsx';
import {
  DEFAULT_QUERY,
  filtersOf,
  type HoldListPage,
  type HoldListRow,
} from './holds/holds-list-types.ts';
import { queryString } from './holds/holds-query.ts';
import { PayoutHoldsCard } from './holds-card.tsx';

// The seller page's Payout holds (super list 28, compact): the seller order search, filters, sort,
// columns, both List paging modes, selection and Export, and the two money actions (Place hold…
// in the card's header, Release hold… in a row's menu), each level 3 with the two-step code.

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const ME = '0190a000-0000-7000-8000-0000000000a1';
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const ORDER = '0190a000-0000-7000-8000-0000000000b1';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const LIST = `commission-payouts/admin/sellers/${SELLER}/payout-holds`;
const NAME = 'hold 00000001';

const row = (n = 1, over: Partial<HoldListRow> = {}): HoldListRow => ({
  holdId: id(n),
  sellerId: SELLER,
  sellerOrderId: ORDER,
  reason: 'admin-review',
  origin: 'admin',
  placedAt: '2026-10-21T01:00:00.000Z',
  active: true,
  releasedAt: null,
  releaseReason: null,
  actions: ['open-order', 'release'],
  ...over,
});
const released = (n: number, over: Partial<HoldListRow> = {}) =>
  row(n, {
    active: false,
    releasedAt: '2026-10-25T01:00:00.000Z',
    releaseReason: 'resolved',
    actions: ['open-order'],
    ...over,
  });
const pageOf = (holds: HoldListRow[], over: Partial<HoldListPage> = {}): HoldListPage => ({
  holds,
  counts: { active: 3, released: 5 },
  total: holds.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  ...over,
});
/** The answer of Previous and next: no total and no page. */
const openPage = (holds: HoldListRow[], nextCursor: string | null = null) =>
  pageOf(holds, { total: null, page: null, nextCursor });

type Answer = HoldListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string, details: object = { fields: [] }) =>
  Promise.resolve({ ok: false, failure: { status, code, details } } as never);
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: true, status, body } as never);

/** What a POST (place or release) answers; set by the test. */
let post: (path: string, body: unknown) => Promise<never> = () => failure(500, 'unexpected');

function serve(answer: (url: string) => Answer) {
  call.mockImplementation((method, path, body) => {
    if (method === 'POST') return post(path, body);
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return failure(404, 'not-found');
    const result = answer(path);
    if (result === 'fail') return failure(503, 'commission-payouts.unavailable');
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
  options: {
    paging?: 'pages' | 'prev-next';
    zone?: string;
    marketId?: string;
    canPlace?: boolean;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StepUpProvider>
        <PayoutHoldsCard
          sellerId={SELLER}
          paging={options.paging ?? 'pages'}
          accountId={ME}
          marketId={options.marketId ?? 'AU'}
          zone={options.zone ?? BRISBANE}
          canPlace={options.canPlace ?? true}
          csrfToken="csrf-1"
        />
      </StepUpProvider>
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
/**
 * Waits until a hold's row checkbox is on screen. The wait polls a plain attribute selector, not
 * `findByRole`: a role query with a name computes the accessible name of every checkbox on
 * every poll and on every DOM mutation, so on a CI worker already busy with hundreds of other
 * files it starved the very render it was waiting for and gave up after the default 1 s. The
 * role query then runs once, on a DOM that is already complete.
 */
const rowBox = async (label = NAME) => {
  await waitFor(
    () => {
      if (!document.querySelector(`input[type="checkbox"][aria-label="Select ${label}"]`)) {
        throw new Error(`The row "${label}" is not on screen yet.`);
      }
    },
    { timeout: 10_000 },
  );
  return screen.getByRole('checkbox', { name: `Select ${label}` });
};
const firstRow = () => rowBox();
const openMenu = async (name = NAME) => {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};

/** Sets one condition in the filter panel; `add` keeps the conditions already applied. */
const applyFilter = async (field: string, value: string, add = false) => {
  fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
  const panel = await screen.findByRole('dialog', { name: 'Filter' });
  if (add) fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
  const fields = within(panel).getAllByLabelText('Field');
  fireEvent.change(fields[fields.length - 1]!, { target: { value: field } });
  const values = within(panel).getAllByLabelText('Value');
  fireEvent.change(values[values.length - 1]!, { target: { value } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
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
  vi.useRealTimers();
});

describe('Holds list: page numbers', () => {
  it('asks for page 1, active holds first, with no view and no cap of 100, and shows the counts and the rows', async () => {
    serve(() =>
      pageOf(
        [
          row(1),
          row(2, { origin: 'system', reason: 'dispute', sellerOrderId: null, actions: [] }),
          released(3),
        ],
        { total: 143 },
      ),
    );
    mount();
    await firstRow();
    expect(lastParams()).toEqual({
      sort: 'active-first',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    });
    expect(screen.getByText(/3 active holds and 5 released holds/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Payout holds' });
    for (const header of [
      'Covers',
      'Reason',
      'Placed on',
      'Status',
      'Placed by',
      'Released on',
      'Actions',
    ]) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(table).getAllByText('Seller order 000000B1').length).toBe(2);
    expect(within(table).getByText('Whole seller')).toBeTruthy();
    expect(within(table).getByText('Payment disputed')).toBeTruthy();
    expect(within(table).getAllByText('Active', { selector: 'span' }).length).toBe(2);
    expect(within(table).getByText('Released', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Sorted by Status: Active first')).toBeTruthy();
    expect(screen.getByText('1–3 of 143 holds')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Manage filters')).toBeNull();
    // 2026-10-21 01:00 UTC is 11:00 in Brisbane; 2026-10-25 01:00 UTC likewise.
    expect(within(table).getAllByText(/21 Oct/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Times are shown in Australia\/Brisbane\./)).toBeTruthy();
    // A page of 100 is a choice of the footer, not a cap.
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '100' } });
    await waitFor(() => expect(lastParams()['pageSize']).toBe('100'));
  });

  it('has no button in a row; its menu offers Release hold… only where the row names it', async () => {
    serve(() =>
      pageOf([
        row(1),
        row(2, { origin: 'system', reason: 'dispute', actions: ['open-order'] }),
        released(3),
      ]),
    );
    mount();
    await firstRow();
    const buttons = within(screen.getByRole('table'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    // One menu: the system's and the released holds name no action this panel acts on.
    expect(buttons).toEqual([`Actions for ${NAME}`]);
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Release hold…']);
  });

  it('shows a generic label for a hold reason it does not know, never the raw code', async () => {
    serve(() => pageOf([row(1, { reason: 'new-reason-from-api', origin: 'system', actions: [] })]));
    mount();
    await firstRow();
    expect(screen.queryByText('new-reason-from-api')).toBeNull();
    expect(within(screen.getByRole('table')).getByText('On hold')).toBeTruthy();
  });

  it('shows the release details in their columns, and the hold id when chosen', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':seller-holds-columns',
      JSON.stringify(['release-reason', 'released', 'hold']),
    );
    serve(() => pageOf([released(3, { releaseReason: 'placed-in-error' })]));
    mount();
    await rowBox('hold 00000003');
    const table = screen.getByRole('table');
    for (const header of ['Released because', 'Released on', 'Hold ID']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(table).getByText('Placed in error')).toBeTruthy();
    expect(within(table).getByText('00000003')).toBeTruthy();
  });

  it('sends a seller order id as sellerOrderId; text that is not an id asks nothing', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: `\t${ORDER.toUpperCase()}\n` } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['sellerOrderId']).toBe(ORDER));
    expect(lastParams()['q']).toBeUndefined();
    expect(screen.getByText(`Seller order ID is ${ORDER}`)).toBeTruthy();
    const before = listUrls().length;
    fireEvent.change(box, { target: { value: 'MP-1' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/That is not an ID/)).toBeTruthy();
    expect(listUrls()).toHaveLength(before);
  });

  it('filters by status, reason, who placed it, what it covers and a placed date preset', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    serve(() => pageOf([row()], { total: 7 }));
    mount();
    await firstRow();
    await applyFilter('status', 'active');
    await waitFor(() => expect(lastParams()['status']).toBe('active'));
    expect(screen.getByText('7 holds match')).toBeTruthy();
    await applyFilter('reason', 'bank-change', true);
    await waitFor(() => expect(lastParams()['reason']).toBe('bank-change'));
    await applyFilter('origin', 'system', true);
    await waitFor(() => expect(lastParams()['origin']).toBe('system'));
    await applyFilter('scope', 'order', true);
    await waitFor(() => expect(lastParams()['scope']).toBe('order'));
    await applyFilter('placed', 'today', true);
    await waitFor(() => expect(lastParams()['from']).toBeDefined());
    // The 17th in Brisbane (UTC+10).
    expect(lastParams()).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    expect(screen.getByText('Placed by is System')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status is Active' }));
    await waitFor(() => expect(lastParams()['status']).toBeUndefined());
    expect(lastParams()['reason']).toBe('bank-change');
  });

  it('starts each sort on its own first order, and labels the first order as that', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    const active = await screen.findByRole('radio', { name: 'Active first' });
    expect((active as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Released first' }));
    await waitFor(() => expect(lastParams()['direction']).toBe('asc'));
    expect(screen.getByText('Sorted by Status: Released first')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Placed on' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('placed'));
    expect(lastParams()['direction']).toBe('desc');
    const newest = screen.getByRole('radio', { name: 'Newest first' });
    expect((newest as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Sorted by Placed on: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Released on' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('released'));
    expect(screen.getByRole('radio', { name: 'Newest first' })).toBeTruthy();
  });

  it('keeps the ticked rows over paging and for the same id in another case, and drops them for a new search, sort or filter', async () => {
    serve((url) =>
      url.includes('page=2')
        ? pageOf([row(2)], { total: 30, page: 2 })
        : pageOf([row()], { total: 30 }),
    );
    mount();
    fireEvent.click(await firstRow());
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: ORDER } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['sellerOrderId']).toBe(ORDER));
    await waitFor(() => expect(screen.queryByText('1 hold selected')).toBeNull());
    fireEvent.click(await firstRow());
    const reads = listUrls().length;
    fireEvent.change(box, { target: { value: ORDER.toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    await firstRow();
    expect(screen.getByText('1 hold selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await rowBox('hold 00000002')).toBeTruthy();
    expect(screen.getByText('1 hold selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Placed on' }));
    await waitFor(() => expect(screen.queryByText('1 hold selected')).toBeNull());
    fireEvent.click(await firstRow());
    await applyFilter('status', 'active');
    await waitFor(() => expect(screen.queryByText('1 hold selected')).toBeNull());
  });

  it('goes back to the last page with rows when a page is past the end', async () => {
    serve((url) => {
      if (url.includes('page=4')) return pageOf([], { total: 30, page: 4 });
      if (url.includes('page=2')) return pageOf([row(2)], { total: 30, page: 2 });
      return pageOf([row()], { total: 90 });
    });
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(await rowBox('hold 00000002')).toBeTruthy();
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
    expect(await screen.findByText('The holds could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await firstRow()).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to these holds.')).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/sellers' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the empty state, and a no-match state with Clear all', async () => {
    serve(() => pageOf([], { total: 0, counts: { active: 0, released: 0 } }));
    mount();
    expect(await screen.findByText('No holds')).toBeTruthy();
    expect(screen.getByText("Nothing stops this seller's payouts.")).toBeTruthy();
    await applyFilter('status', 'released');
    expect(await screen.findByText('No holds match')).toBeTruthy();
    const clear = screen.getAllByRole('button', { name: 'Clear all' });
    fireEvent.click(clear[clear.length - 1]!);
    await waitFor(() => expect(lastParams()['status']).toBeUndefined());
  });
});

describe('Holds list: Previous and next', () => {
  it('sends limit and the cursor only, with no sort, and steps Next, Next, Previous', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([row(3)]);
      if (url.includes('cursor=c1')) return openPage([row(2)], 'c2');
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await firstRow();
    expect(lastParams()).toEqual({ limit: '25' });
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
    expect(screen.getByText('Sorted by Placed on: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await rowBox('hold 00000002');
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c1' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await rowBox('hold 00000003');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await rowBox('hold 00000002');
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c1' });
  });

  it('steps back once when a page comes back empty', async () => {
    serve((url) => (url.includes('cursor=c1') ? openPage([]) : openPage([row()], 'c1')));
    mount({ paging: 'prev-next' });
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listUrls()).toHaveLength(3));
    await firstRow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listUrls()).toHaveLength(3);
    expect(lastParams()).toEqual({ limit: '25' });
  });
});

describe('Holds list: queries and export', () => {
  const context = { paging: 'pages', zone: BRISBANE, now: NOW } as const;

  it('builds the list query with every filter and never the seller', () => {
    const query = {
      ...DEFAULT_QUERY,
      filters: {
        status: 'released',
        reason: 'dispute',
        origin: 'system',
        scope: 'order',
        placed: 'today',
      },
    } as const;
    const params = new URLSearchParams(queryString(query, context, ORDER));
    expect(Object.fromEntries(params)).toEqual({
      sellerOrderId: ORDER,
      status: 'released',
      reason: 'dispute',
      origin: 'system',
      scope: 'order',
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      sort: 'active-first',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    });
    expect(params.has('sellerId')).toBe(false);
  });

  it('reads the date preset on the clock of the zone of another Market', () => {
    const query = { ...DEFAULT_QUERY, filters: { placed: 'today' } } as const;
    const tokyo = { paging: 'pages', zone: 'Asia/Tokyo', now: NOW } as const;
    // The 17th in Tokyo (UTC+9) starts at 15:00 UTC on the 16th.
    expect(new URLSearchParams(queryString(query, tokyo, '')).get('from')).toBe(
      '2026-11-16T15:00:00.000Z',
    );
  });

  it('keeps only known filters and columns, and maps them to the columns of the export', () => {
    expect(filtersOf({ status: 'active', reason: 'nope', scope: 'order', placed: 'x' })).toEqual({
      status: 'active',
      scope: 'order',
    });
    expect(cleanColumns(['hold', 'nope', 'hold', 'origin'])).toEqual(['hold', 'origin']);
    expect(cleanColumns(undefined)).toEqual(['origin', 'released']);
    expect(cleanColumns([])).toEqual([]);
    expect(exportColumns(['origin', 'release-reason', 'released', 'hold'])).toEqual([
      'release-reason',
      'hold-id',
    ]);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: ORDER, filters: { status: 'active' } } as const;
    const base = { query, zone: BRISBANE, format: 'xlsx', columns: ['hold'] } as const;
    expect(
      Object.fromEntries(
        new URLSearchParams(
          exportParams({
            ...base,
            paging: 'pages',
            selection: { ids: [id(1)], allMatching: false, total: 3 },
          }),
        ),
      ),
    ).toEqual({ ids: id(1), format: 'xlsx', columns: 'hold-id' });
    expect(
      Object.fromEntries(
        new URLSearchParams(
          exportParams({
            ...base,
            paging: 'pages',
            selection: { ids: [], allMatching: true, total: 3 },
            now: NOW,
          }),
        ),
      ),
    ).toEqual({
      sellerOrderId: ORDER,
      status: 'active',
      sort: 'active-first',
      direction: 'desc',
      format: 'xlsx',
      columns: 'hold-id',
    });
    const open = new URLSearchParams(
      exportParams({
        ...base,
        query: { ...query, sort: 'released', direction: 'asc' },
        paging: 'prev-next',
        selection: { ids: [], allMatching: true, total: null },
      }),
    );
    expect(open.get('sort')).toBe('placed');
    expect(open.get('direction')).toBe('desc');
  });

  const stubDownload = () => {
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
    return fetched;
  };
  const runExport = async (format?: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    // Export is the only bulk action: no hold is placed or released in bulk.
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Export/ }));
    const dialog = await screen.findByRole('dialog');
    if (format !== undefined) fireEvent.click(within(dialog).getByLabelText(format));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
  };

  it('downloads the file of the ticked holds', async () => {
    const fetched = stubDownload();
    serve(() => pageOf([row()]));
    mount();
    const box = await firstRow();
    expect(screen.getByRole('button', { name: 'Bulk action' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(box);
    await runExport();
    await waitFor(() => expect(fetched).toHaveLength(1));
    const url = new URL(fetched[0]!, 'http://x');
    expect(url.pathname).toBe(`/api/${LIST}/export`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ ids: id(1), format: 'csv' });
  });

  it('selects all matching holds, exports them by the selector, and drops them for another filter', async () => {
    const fetched = stubDownload();
    serve(() => pageOf([row()], { total: 30 }));
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all holds on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 30 matching' }));
    expect(screen.getByText('All 30 matching holds are selected')).toBeTruthy();
    await runExport(/XLSX/);
    await waitFor(() => expect(fetched).toHaveLength(1));
    const params = Object.fromEntries(new URL(fetched[0]!, 'http://x').searchParams);
    expect(params['ids']).toBeUndefined();
    expect(params).toMatchObject({ sort: 'active-first', direction: 'desc', format: 'xlsx' });
    await applyFilter('status', 'active');
    await waitFor(() =>
      expect(screen.queryByText('All 30 matching holds are selected')).toBeNull(),
    );
  });

  it('offers Select all matching without a count under Previous and next', async () => {
    const fetched = stubDownload();
    serve(() => openPage([row()], 'c1'));
    mount({ paging: 'prev-next' });
    await firstRow();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all holds on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching holds are selected')).toBeTruthy();
    await runExport();
    await waitFor(() => expect(fetched).toHaveLength(1));
    expect(Object.fromEntries(new URL(fetched[0]!, 'http://x').searchParams)).toEqual({
      sort: 'placed',
      direction: 'desc',
      format: 'csv',
    });
  });

  const saved = vi.fn(() => 'blob:x');
  async function exportWith(response: Response) {
    saved.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response)),
    );
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: saved, revokeObjectURL: () => {} }));
    serve(() => pageOf([row()]));
    mount();
    fireEvent.click(await firstRow());
    await runExport();
  }
  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('says when the file would be too large, and saves none', async () => {
    await exportWith(json(413, { code: 'batch.too-large', details: { max: 10000, total: 12000 } }));
    expect(await screen.findByText(/Too many rows to export/)).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });

  it('says when the export filters are refused, and saves none', async () => {
    await exportWith(
      json(400, { code: 'validation.failed', details: { fields: [{ path: 'from' }] } }),
    );
    expect(await screen.findByText(/can't be exported with its current filters/)).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });

  it('says when the export service is down, and saves none', async () => {
    await exportWith(json(503, { code: 'commission-payouts.unavailable' }));
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });
});

describe('Holds list: Place hold… and Release hold…', () => {
  const SELLER_ID = '000000C1';
  const typeId = (dialog: HTMLElement, text: string) =>
    fireEvent.change(within(dialog).getByLabelText(/^Type the (seller|hold) ID/), {
      target: { value: text },
    });
  const confirm = (dialog: HTMLElement, name: string) =>
    within(dialog).getByRole<HTMLButtonElement>('button', { name });

  it('has Place hold… in the header only for the key, and nothing for it in a row', async () => {
    serve(() => pageOf([row()]));
    mount({ canPlace: false });
    await firstRow();
    expect(screen.queryByRole('button', { name: 'Place hold…' })).toBeNull();
    cleanup();
    mount();
    await firstRow();
    expect(screen.getByRole('button', { name: 'Place hold…' })).toBeTruthy();
  });

  it('places a hold on the whole seller: level 3, focus on Cancel, typed seller id, the code, then reads again', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Place hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a payout hold?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByText(/You will be asked for your two-step code next/)).toBeTruthy();
    // Nothing works until a reason is chosen and the seller ID is typed.
    expect(confirm(dialog, 'Place hold').disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'bank-change' } });
    expect(confirm(dialog, 'Place hold').disabled).toBe(true);
    typeId(dialog, 'wrong');
    expect(confirm(dialog, 'Place hold').disabled).toBe(true);
    typeId(dialog, SELLER_ID);
    expect(confirm(dialog, 'Place hold').disabled).toBe(false);
    post = () => ok(row(9, { reason: 'bank-change', sellerOrderId: null }));
    const reads = listUrls().length;
    fireEvent.click(confirm(dialog, 'Place hold'));
    await waitFor(() =>
      expect(posts()[0]).toEqual([
        'POST',
        `commission-payouts/admin/sellers/${SELLER}/payout-holds`,
        { reason: 'bank-change' },
        'csrf-1',
      ]),
    );
    await expectToast('Hold placed.', 'success');
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    await waitFor(() => expect(dialog.hasAttribute('open')).toBe(false));
  });

  it('needs a full seller order id to hold one order, and sends it in lower case', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Place hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a payout hold?' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'admin-review' },
    });
    fireEvent.click(within(dialog).getByLabelText('One seller order'));
    typeId(dialog, SELLER_ID);
    expect(confirm(dialog, 'Place hold').disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Seller order ID'), {
      target: { value: 'MP-1' },
    });
    expect(within(dialog).getByText('Enter the full seller order ID.')).toBeTruthy();
    expect(confirm(dialog, 'Place hold').disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Seller order ID'), {
      target: { value: ` ${ORDER.toUpperCase()} ` },
    });
    expect(confirm(dialog, 'Place hold').disabled).toBe(false);
    post = () => ok(row());
    fireEvent.click(confirm(dialog, 'Place hold'));
    await waitFor(() =>
      expect(posts()[0]?.[2]).toEqual({ reason: 'admin-review', sellerOrderId: ORDER }),
    );
  });

  it('starts each opening empty, and a cancelled code leaves the dialog as it was', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Place hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a payout hold?' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'bank-change' } });
    typeId(dialog, SELLER_ID);
    post = () =>
      failure(403, 'second-factor.required', { actionKey: 'commission-payouts.payout-hold.place' });
    fireEvent.click(confirm(dialog, 'Place hold'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const stepUp = await waitFor(() => {
      const found = screen
        .getAllByRole('dialog')
        .find((d) => d !== dialog && d.hasAttribute('open') && d.textContent?.includes('Cancel'));
      if (found === undefined) throw new Error('no step-up dialog');
      return found;
    });
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog.hasAttribute('open')).toBe(true));
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Reason').value).toBe('bank-change');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    // Closing and opening again starts empty.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog.hasAttribute('open')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Place hold…' }));
    const again = await screen.findByRole('dialog', { name: 'Place a payout hold?' });
    expect(within(again).getByLabelText<HTMLSelectElement>('Reason').value).toBe('');
    expect(confirm(again, 'Place hold').disabled).toBe(true);
  });

  it("says the order is not the seller's, and reads the list again after the refusal", async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Place hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a payout hold?' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'admin-review' },
    });
    fireEvent.click(within(dialog).getByLabelText('One seller order'));
    fireEvent.change(within(dialog).getByLabelText('Seller order ID'), {
      target: { value: ORDER },
    });
    typeId(dialog, SELLER_ID);
    post = () => failure(404, 'commission-payouts.seller-order-not-found');
    const reads = listUrls().length;
    fireEvent.click(confirm(dialog, 'Place hold'));
    expect(
      await within(dialog).findByText("That order is not one of this seller's orders."),
    ).toBeTruthy();
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    // The dialog stays open with what was typed, so the admin can fix it.
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('releases a hold from its row menu: level 3, typed hold id, a reason, the code, then reads again', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await firstRow();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Release hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release this payout hold?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(confirm(dialog, 'Release hold').disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason for releasing'), {
      target: { value: 'review-complete' },
    });
    expect(confirm(dialog, 'Release hold').disabled).toBe(true);
    typeId(dialog, '00000001');
    expect(confirm(dialog, 'Release hold').disabled).toBe(false);
    post = () => ok(released(1, { releaseReason: 'review-complete' }));
    const reads = listUrls().length;
    fireEvent.click(confirm(dialog, 'Release hold'));
    await waitFor(() =>
      expect(posts()[0]).toEqual([
        'POST',
        `commission-payouts/admin/payout-holds/${id(1)}/release`,
        { reason: 'review-complete' },
        'csrf-1',
      ]),
    );
    await expectToast('Hold released.', 'success');
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
  });

  it("warns about a suspended seller's hold in the release dialog", async () => {
    serve(() => pageOf([row(1, { reason: 'seller-suspended', origin: 'system' })]));
    mount();
    await firstRow();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Release hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release this payout hold?' });
    expect(within(dialog).getByText(/Only an admin can release it/)).toBeTruthy();
  });

  it('says a hold was already released, keeps the dialog, and reads the list again', async () => {
    let state: 'before' | 'after' = 'before';
    serve(() => pageOf([state === 'before' ? row(1) : released(1, { releaseReason: 'resolved' })]));
    mount();
    await firstRow();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Release hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release this payout hold?' });
    fireEvent.change(within(dialog).getByLabelText('Reason for releasing'), {
      target: { value: 'resolved' },
    });
    typeId(dialog, '00000001');
    post = () => {
      state = 'after';
      return failure(409, 'commission-payouts.hold-already-released');
    };
    const reads = listUrls().length;
    fireEvent.click(confirm(dialog, 'Release hold'));
    expect(await within(dialog).findByText(/already released/)).toBeTruthy();
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    // The row behind the dialog now shows the truth: released, and no menu.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `Actions for ${NAME}` })).toBeNull(),
    );
  });

  it('says the action is denied, and reads again after any refusal', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await firstRow();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Release hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release this payout hold?' });
    fireEvent.change(within(dialog).getByLabelText('Reason for releasing'), {
      target: { value: 'resolved' },
    });
    typeId(dialog, '00000001');
    post = () => failure(403, 'access.denied');
    const reads = listUrls().length;
    fireEvent.click(confirm(dialog, 'Release hold'));
    expect(await within(dialog).findByText(/may be acting as a seller/)).toBeTruthy();
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
  });

  it('sends a signed-out admin away from a hold action', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await firstRow();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/sellers' });
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Release hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release this payout hold?' });
    fireEvent.change(within(dialog).getByLabelText('Reason for releasing'), {
      target: { value: 'resolved' },
    });
    typeId(dialog, '00000001');
    post = () => failure(401, 'session.invalid');
    const reads = listUrls().length;
    fireEvent.click(confirm(dialog, 'Release hold'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    // A lost session is not a stale row: no read follows.
    expect(listUrls()).toHaveLength(reads);
  });
});

describe('Holds list: columns and Markets', () => {
  it('keeps the column choice for this viewer in storage, and drops an unknown stored id', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':seller-holds-columns',
      JSON.stringify(['hold', 'nope']),
    );
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Hold ID' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Placed by' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Hold ID' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(table).queryByRole('columnheader', { name: 'Hold ID' })).toBeNull(),
    );
    expect(
      JSON.parse(window.localStorage.getItem('mp:admin:AU:' + ME + ':seller-holds-columns')!),
    ).toEqual([]);
  });

  it('shows the times in the zone of the list, and keeps the column choice per Market', async () => {
    window.localStorage.setItem(
      'mp:admin:NZ:' + ME + ':seller-holds-columns',
      JSON.stringify(['released']),
    );
    // 21:30 on the 10th in Brisbane (UTC+10), already 00:30 on the 11th in Auckland (UTC+13).
    serve(() =>
      pageOf([
        released(1, {
          placedAt: '2026-11-10T11:30:00.000Z',
          releasedAt: '2026-11-12T11:30:00.000Z',
        }),
      ]),
    );
    mount({ zone: 'Pacific/Auckland', marketId: 'NZ' });
    await rowBox('hold 00000001');
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Released on' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Placed by' })).toBeNull();
    expect(within(table).getAllByText(/11 Nov/).length).toBeGreaterThan(0);
    expect(within(table).queryByText(/10 Nov/)).toBeNull();
    expect(screen.getByText(/Times are shown in Pacific\/Auckland\./)).toBeTruthy();
  });
});
