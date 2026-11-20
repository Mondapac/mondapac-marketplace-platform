// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { cleanColumns, exportColumns } from './ledger/ledger-columns.ts';
import { exportParams } from './ledger/ledger-export.tsx';
import { DEFAULT_QUERY, filtersOf, type LedgerListRow } from './ledger/ledger-list-types.ts';
import { minorOfStep, queryString } from './ledger/ledger-query.ts';
import { LedgerCard } from './ledger-card.tsx';
import type { Ledger } from './types.ts';

// The seller page's Commission ledger (super list 27, compact): totals over every row, the
// order-id search, filters, sort, columns, both List paging modes, selection and Export. No views
// and no saved filters. The seller is in the path of every call.

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const ME = '0190a000-0000-7000-8000-0000000000a1';
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const ORDER = '0190a000-0000-7000-8000-0000000000b1';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const LIST = `commission-payouts/admin/sellers/${SELLER}/ledger`;
const NAME = 'ledger row 00000001';

const row = (n = 1, over: Partial<LedgerListRow> = {}): LedgerListRow => ({
  entryId: id(n),
  orderId: id(100 + n),
  sellerOrderId: id(200 + n),
  orderLineId: null,
  kind: 'sale',
  direction: 'credit',
  amount: '3000',
  rateBps: null,
  baseAmount: null,
  sourceId: null,
  occurredAt: '2026-10-14T10:00:00.000Z',
  recordedAt: '2026-10-14T10:05:00.000Z',
  actions: ['open-order'],
  ...over,
});
const TOTALS: Ledger['totals'] = {
  sales: '3000',
  shipping: '500',
  commission: '450',
  refundedSales: '0',
  refundedShipping: '0',
  refundedCommission: '0',
  disputeDebits: '0',
  disputeReinstated: '0',
  sellerCashback: '0',
  balance: '3050',
};
const pageOf = (entries: LedgerListRow[], over: Partial<Ledger> = {}): Ledger => ({
  sellerId: SELLER,
  currency: 'AUD',
  totals: TOTALS,
  entries,
  nextCursor: null,
  total: entries.length,
  page: 1,
  pageSize: 25,
  ...over,
});
/** The answer of Previous and next: no total and no page. */
const openPage = (entries: LedgerListRow[], nextCursor: string | null = null) =>
  pageOf(entries, { total: null, page: null, nextCursor, pageSize: 25 });

type Answer = Ledger | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string, details: object = { fields: [] }) =>
  Promise.resolve({ ok: false, failure: { status, code, details } } as never);
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: true, status, body } as never);

function serve(answer: (url: string) => Answer) {
  call.mockImplementation((method, path) => {
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return failure(404, 'not-found');
    const result = answer(path);
    if (result === 'fail') return failure(503, 'commission-payouts.rate-unavailable');
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

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    zone?: string;
    marketId?: string;
    currency?: string;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <LedgerCard
        sellerId={SELLER}
        currency={options.currency ?? 'AUD'}
        initialTotals={TOTALS}
        paging={options.paging ?? 'pages'}
        accountId={ME}
        marketId={options.marketId ?? 'AU'}
        zone={options.zone ?? BRISBANE}
      />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
const firstRow = () => screen.findByRole('checkbox', { name: `Select ${NAME}` });
const openMenu = async (name = NAME) => {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};

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
  vi.useRealTimers();
});

/** Sets one condition in the filter panel; `add` keeps the conditions already applied. */
const applyFilter = async (field: string, value: string, add = false) => {
  fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
  const panel = await screen.findByRole('dialog', { name: 'Filter' });
  if (add) fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
  const fields = within(panel).getAllByLabelText('Field');
  const values = within(panel).getAllByLabelText('Value');
  fireEvent.change(fields[fields.length - 1]!, { target: { value: field } });
  fireEvent.change(within(panel).getAllByLabelText('Value').at(-1) ?? values[0]!, {
    target: { value },
  });
  fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
};

describe('Ledger list: page numbers', () => {
  it('asks for page 1, newest record first, with no view, and shows the totals, the row and the range', async () => {
    serve(() =>
      pageOf([row(), row(2, { kind: 'commission', direction: 'debit', amount: '450' })], {
        total: 143,
      }),
    );
    mount();
    await firstRow();
    expect(lastParams()).toEqual({
      sort: 'recorded',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    });
    expect(listUrls()[0]).toContain(`${LIST}?`);
    // The balance tile is the whole seller's, from the answer.
    const balance = screen.getAllByText('Balance').find((n) => n.tagName === 'DT');
    expect(balance?.nextElementSibling?.textContent).toBe('$30.50');
    const table = screen.getByRole('table');
    for (const header of ['Kind', 'Amount', 'Recorded on', 'Order', 'Actions']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(table).queryByRole('columnheader', { name: 'Occurred on' })).toBeNull();
    expect(within(table).getByText('−$4.50')).toBeTruthy();
    expect(within(table).getByText('$30.00')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Amount' }).className).toContain('text-end');
    expect(screen.getByText('Sorted by Recorded on: Newest first')).toBeTruthy();
    expect(screen.getByText('1–2 of 143 rows')).toBeTruthy();
    // No views bar and no saved filters.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Manage filters')).toBeNull();
    // The times are on the list's zone: 2026-10-14 10:05 UTC is the 14th, 20:05 in Brisbane.
    expect(within(table).getAllByText(/14 Oct/).length).toBeGreaterThan(0);
    expect(screen.getByText('Dates are shown in Australia/Brisbane.')).toBeTruthy();
  });

  it('shows refund totals, the kinds and a balance below zero, from each answer', async () => {
    serve(() =>
      pageOf(
        [
          row(1, { kind: 'refund-sale', direction: 'debit', amount: '1100' }),
          row(2, { kind: 'refund-commission', direction: 'credit', amount: '150' }),
        ],
        {
          totals: {
            ...TOTALS,
            refundedSales: '1100',
            refundedShipping: '250',
            refundedCommission: '150',
            balance: '-1200',
          },
        },
      ),
    );
    mount();
    await firstRow();
    for (const [label, value] of [
      ['Refunds', '$13.50'],
      ['Commission returned', '$1.50'],
      ['Balance', '-$12.00'],
    ] as const) {
      const term = screen.getAllByText(label).find((n) => n.tagName === 'DT');
      expect(term?.nextElementSibling?.textContent).toBe(value);
    }
    expect(screen.getByText('Refund of sale')).toBeTruthy();
  });

  it('shows the cashback tile and a row of that kind as a debit, in AUD and JPY', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    expect(screen.queryByText('Cashback to exclusive customers')).toBeNull();
    cleanup();
    for (const currency of ['AUD', 'JPY']) {
      serve(() =>
        pageOf([row(1, { kind: 'cashback-seller', direction: 'debit', amount: '500' })], {
          currency,
          totals: { ...TOTALS, sellerCashback: '500' },
        }),
      );
      mount({ currency });
      await firstRow();
      const term = screen
        .getAllByText('Cashback to exclusive customers')
        .find((n) => n.tagName === 'DT');
      expect(term?.nextElementSibling?.textContent).toMatch(
        currency === 'AUD' ? /\$5\.00/ : /(?<![\d,.])500(?![\d,.])/,
      );
      expect(within(screen.getByRole('table')).getByText(/^−/)).toBeTruthy();
      cleanup();
    }
  });

  it('has no button in a row; its menu offers Open order when the row names it, and goes to the order', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/sellers' });
    serve(() => pageOf([row(1, { actions: ['refund', 'open-order'] })]));
    mount();
    await firstRow();
    const buttons = within(screen.getByRole('table'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual([`Actions for ${NAME}`]);
    // The order column is plain text: the menu is the one way to the order.
    expect(within(screen.getByRole('table')).queryByRole('link')).toBeNull();
    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Open order']);
    fireEvent.click(items[0]!);
    expect(assign).toHaveBeenCalledWith(`/orders/${id(101)}`);
  });

  it('offers no menu on a row that names no action, and shows a kind it does not know as Other', async () => {
    serve(() => pageOf([row(1, { actions: [], kind: 'brand-new' as never })]));
    mount();
    await firstRow();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(within(screen.getByRole('table')).getByText('Other')).toBeTruthy();
    expect(screen.queryByText('brand-new')).toBeNull();
  });

  it('shows the optional columns the admin chooses, with their values', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':seller-ledger-columns',
      JSON.stringify(['rate', 'base', 'source', 'order-line', 'entry']),
    );
    serve(() =>
      pageOf([
        row(1, {
          kind: 'commission',
          direction: 'debit',
          rateBps: 1250,
          baseAmount: '3000',
          sourceId: id(900),
          orderLineId: id(901),
        }),
      ]),
    );
    mount();
    await firstRow();
    const table = screen.getByRole('table');
    for (const header of [
      'Commission rate',
      'Amount before GST',
      'Refund or dispute',
      'Order line',
      'Row ID',
    ]) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(table).getByText('12.5%')).toBeTruthy();
    expect(within(table).getByText('00000900')).toBeTruthy();
  });

  it('sends an id as q (lower-case, control characters as spaces); text that is not an id asks nothing', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: `\t${ORDER.toUpperCase()}\n` } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(ORDER));
    expect(screen.getByText(`Order or seller order ID is ${ORDER}`)).toBeTruthy();
    const before = listUrls().length;
    fireEvent.change(box, { target: { value: 'Ada Lovelace' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/That is not an ID/)).toBeTruthy();
    expect(listUrls()).toHaveLength(before);
    expect(lastParams()['q']).toBe(ORDER);
  });

  it('filters by kind, credit or debit, and shows each filter as a removable chip', async () => {
    serve(() => pageOf([row()], { total: 7 }));
    mount();
    await firstRow();
    await applyFilter('kind', 'commission');
    await waitFor(() => expect(lastParams()['kind']).toBe('commission'));
    expect(screen.getByText('7 rows match')).toBeTruthy();
    await applyFilter('side', 'debit', true);
    await waitFor(() => expect(lastParams()['side']).toBe('debit'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Kind is Commission' }));
    await waitFor(() => expect(lastParams()['kind']).toBeUndefined());
    expect(lastParams()['side']).toBe('debit');
  });

  it('filters by a recorded date preset on the list zone and by amounts in whole currency units', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    await applyFilter('recorded', 'today');
    await waitFor(() => expect(lastParams()['from']).toBeDefined());
    // The 17th in Brisbane (UTC+10).
    expect(lastParams()).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    await applyFilter('minAmount', '100', true);
    await waitFor(() => expect(lastParams()['minAmount']).toBe('10000'));
    await applyFilter('maxAmount', '500', true);
    await waitFor(() => expect(lastParams()['maxAmount']).toBe('50000'));
    expect(screen.getByText('Amount at least is $100')).toBeTruthy();
    expect(screen.getByText('Amount at most is $500')).toBeTruthy();
  });

  it('starts each sort on its own first order, and labels the first order as that', async () => {
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    // Recorded on starts newest first, so that is its first radio and it is chosen.
    const newest = await screen.findByRole('radio', { name: 'Newest first' });
    expect((newest as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Oldest first' }));
    await waitFor(() => expect(lastParams()['direction']).toBe('asc'));
    expect(screen.getByText('Sorted by Recorded on: Oldest first')).toBeTruthy();
    // Another field starts on its own first order.
    fireEvent.click(screen.getByRole('radio', { name: 'Amount' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('amount'));
    expect(lastParams()['direction']).toBe('desc');
    const largest = screen.getByRole('radio', { name: 'Largest first' });
    expect((largest as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Sorted by Amount: Largest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Occurred on' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('occurred'));
    expect(screen.getByRole('radio', { name: 'Newest first' })).toBeTruthy();
  });

  it('keeps the ticked rows over paging and for the same id in another case, and drops them for a new search', async () => {
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
    await waitFor(() => expect(lastParams()['q']).toBe(ORDER));
    // A new search is another list: the tick goes.
    await waitFor(() => expect(screen.queryByText('1 row selected')).toBeNull());
    fireEvent.click(await firstRow());
    const reads = listUrls().length;
    fireEvent.change(box, { target: { value: ORDER.toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // The same id in capitals is the same list: the tick stays.
    await waitFor(() => expect(listUrls().length).toBe(reads + 1));
    await firstRow();
    expect(screen.getByText('1 row selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(
      await screen.findByRole('checkbox', { name: 'Select ledger row 00000002' }),
    ).toBeTruthy();
    expect(screen.getByText('1 row selected')).toBeTruthy();
  });

  it('drops the ticked rows when the sort or a filter changes', async () => {
    serve(() => pageOf([row()]));
    mount();
    const tick = async () => {
      fireEvent.click(await firstRow());
      expect(screen.getByText('1 row selected')).toBeTruthy();
    };
    const cleared = () => waitFor(() => expect(screen.queryByText('1 row selected')).toBeNull());
    await tick();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Amount' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('amount'));
    await cleared();
    await tick();
    await applyFilter('kind', 'sale');
    await waitFor(() => expect(lastParams()['kind']).toBe('sale'));
    await cleared();
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
    expect(
      await screen.findByRole('checkbox', { name: 'Select ledger row 00000002' }),
    ).toBeTruthy();
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
    expect(await screen.findByText('The ledger rows could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await firstRow()).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to this ledger.')).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/sellers' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the empty state, and a no-match state with Clear all', async () => {
    serve(() => pageOf([], { total: 0 }));
    mount();
    expect(await screen.findByText(/No ledger rows yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    await applyFilter('kind', 'sale');
    expect(await screen.findByText('No ledger rows match')).toBeTruthy();
    const clear = screen.getAllByRole('button', { name: 'Clear all' });
    fireEvent.click(clear[clear.length - 1]!);
    await waitFor(() => expect(lastParams()['kind']).toBeUndefined());
  });
});

describe('Ledger list: Previous and next', () => {
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
    expect(screen.getByText('Sorted by Recorded on: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('checkbox', { name: 'Select ledger row 00000002' });
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c1' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('checkbox', { name: 'Select ledger row 00000003' });
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c2' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByRole('checkbox', { name: 'Select ledger row 00000002' });
    expect(lastParams()).toEqual({ limit: '25', cursor: 'c1' });
  });

  it('steps back once when a page comes back empty', async () => {
    serve((url) => (url.includes('cursor=c1') ? openPage([]) : openPage([row()], 'c1')));
    mount({ paging: 'prev-next' });
    await firstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listUrls()).toHaveLength(3));
    await firstRow();
    // The empty page asked for once, then the first page again: no loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listUrls()).toHaveLength(3);
    expect(lastParams()).toEqual({ limit: '25' });
  });

  it('sends the cursor only with the list scoped by a search, and never a sort', async () => {
    serve(() => openPage([row()], 'c1'));
    mount({ paging: 'prev-next' });
    await firstRow();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: ORDER } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastParams()['q']).toBe(ORDER));
    expect(lastParams()['sort']).toBeUndefined();
    expect(lastParams()['page']).toBeUndefined();
  });
});

describe('Ledger list: queries and export', () => {
  const context = { paging: 'pages', zone: BRISBANE, currency: 'AUD', now: NOW } as const;

  it('builds the list query with every filter and never the seller', () => {
    const query = {
      ...DEFAULT_QUERY,
      filters: {
        kind: 'sale',
        side: 'credit',
        recorded: 'today',
        minAmount: '10',
        maxAmount: '1000',
      },
    } as const;
    const params = new URLSearchParams(queryString(query, context, ORDER));
    expect(Object.fromEntries(params)).toEqual({
      q: ORDER,
      kind: 'sale',
      side: 'credit',
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      minAmount: '1000',
      maxAmount: '100000',
      sort: 'recorded',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    });
    expect(params.has('sellerId')).toBe(false);
  });

  it('turns whole currency units into minor units of the currency, in a second Market', () => {
    expect(minorOfStep('100', 'AUD')).toBe('10000');
    expect(minorOfStep('100', 'JPY')).toBe('100');
    const jpy = { ...context, zone: 'Asia/Tokyo', currency: 'JPY' };
    const query = { ...DEFAULT_QUERY, filters: { minAmount: '50', recorded: 'today' } } as const;
    expect(Object.fromEntries(new URLSearchParams(queryString(query, jpy, '')))).toMatchObject({
      minAmount: '50',
      // The 17th in Tokyo (UTC+9) starts at 15:00 UTC on the 16th.
      from: '2026-11-16T15:00:00.000Z',
    });
  });

  it('keeps only known filters and columns', () => {
    expect(
      filtersOf({ kind: 'sale', side: 'sideways', minAmount: '7', recorded: 'today' }),
    ).toEqual({ kind: 'sale', recorded: 'today' });
    expect(cleanColumns(['rate', 'nope', 'rate', 'entry'])).toEqual(['rate', 'entry']);
    expect(cleanColumns(undefined)).toEqual([]);
    expect(cleanColumns([])).toEqual([]);
  });

  it('maps the columns on screen to the columns of the export', () => {
    expect(exportColumns(['occurred', 'seller-order', 'entry', 'rate', 'occurred'])).toEqual([
      'occurred',
      'entry-id',
      'rate',
    ]);
    expect(exportColumns([])).toEqual([]);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: ORDER.toUpperCase(), filters: { kind: 'sale' } } as const;
    const base = {
      query,
      zone: BRISBANE,
      currency: 'AUD',
      format: 'csv',
      columns: ['rate'],
    } as const;
    const ticked = new URLSearchParams(
      exportParams({
        ...base,
        paging: 'pages',
        columns: ['rate', 'seller-order'],
        selection: { ids: [id(1), id(2)], allMatching: false, total: 30 },
      }),
    );
    expect(Object.fromEntries(ticked)).toEqual({
      ids: `${id(1)},${id(2)}`,
      format: 'csv',
      columns: 'rate',
    });
    const all = new URLSearchParams(
      exportParams({
        ...base,
        paging: 'pages',
        selection: { ids: [], allMatching: true, total: 30 },
        now: NOW,
      }),
    );
    expect(Object.fromEntries(all)).toEqual({
      q: ORDER,
      kind: 'sale',
      sort: 'recorded',
      direction: 'desc',
      format: 'csv',
      columns: 'rate',
    });
    // Previous and next: the file keeps the newest-first order on screen, whatever the query held.
    const open = new URLSearchParams(
      exportParams({
        ...base,
        query: { ...query, sort: 'amount', direction: 'asc' },
        paging: 'prev-next',
        selection: { ids: [], allMatching: true, total: null },
      }),
    );
    expect(open.get('sort')).toBe('recorded');
    expect(open.get('direction')).toBe('desc');
    expect(() =>
      exportParams({
        ...base,
        paging: 'pages',
        selection: { ids: [], allMatching: false, total: 3 },
      }),
    ).toThrow('export.no-rows-selected');
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

  it('downloads the file of the ticked rows from the Bulk action menu', async () => {
    const fetched = stubDownload();
    serve(() => pageOf([row()]));
    mount();
    const box = await firstRow();
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk.hasAttribute('disabled')).toBe(true);
    fireEvent.click(box);
    fireEvent.click(bulk);
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    // Export is the only bulk action: nothing is changed in bulk.
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Export/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
    await waitFor(() => expect(fetched).toHaveLength(1));
    const url = new URL(fetched[0]!, 'http://x');
    expect(url.pathname).toBe(`/api/${LIST}/export`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ ids: id(1), format: 'csv' });
  });

  it('selects all matching rows and exports them by the selector, on the clock of the read', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const fetched = stubDownload();
    serve(() => pageOf([row()], { total: 30 }));
    mount();
    await applyFilter('recorded', 'today');
    await waitFor(() => expect(lastParams()['from']).toBeDefined());
    await firstRow();
    // Midnight passes before the file is asked for: the window stays the one on screen.
    vi.setSystemTime(new Date('2026-11-17T20:30:00.000Z'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 30 matching' }));
    expect(screen.getByText('All 30 matching rows are selected')).toBeTruthy();
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
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      sort: 'recorded',
      direction: 'desc',
      format: 'xlsx',
    });
    // Another filter is another list: the selection of all matching goes.
    await applyFilter('kind', 'sale');
    await waitFor(() => expect(screen.queryByText('All 30 matching rows are selected')).toBeNull());
  });

  it('offers Select all matching without a count under Previous and next, and exports by selector', async () => {
    const fetched = stubDownload();
    serve(() => openPage([row()], 'c1'));
    mount({ paging: 'prev-next' });
    await firstRow();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching rows are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
    await waitFor(() => expect(fetched).toHaveLength(1));
    const params = Object.fromEntries(new URL(fetched[0]!, 'http://x').searchParams);
    expect(params).toEqual({ sort: 'recorded', direction: 'desc', format: 'csv' });
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
    await exportWith(json(503, { code: 'commission-payouts.rate-unavailable' }));
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });
});

describe('Ledger list: columns and Markets', () => {
  it('keeps the column choice for this viewer in storage, and drops an unknown stored id', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':seller-ledger-columns',
      JSON.stringify(['occurred', 'nope']),
    );
    serve(() => pageOf([row()]));
    mount();
    await firstRow();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Occurred on' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Occurred on' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Commission rate' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(table).queryByRole('columnheader', { name: 'Occurred on' })).toBeNull(),
    );
    expect(
      JSON.parse(window.localStorage.getItem('mp:admin:AU:' + ME + ':seller-ledger-columns')!),
    ).toEqual(['rate']);
  });

  it('shows the amounts in the ledger currency and the times in the zone of the list, per Market', async () => {
    window.localStorage.setItem(
      'mp:admin:JP:' + ME + ':seller-ledger-columns',
      JSON.stringify(['occurred']),
    );
    // 23:30 on the 14th in Brisbane (UTC+10) is 22:30 on the 14th in Tokyo (UTC+9) is the 15th at 00:30 in Auckland.
    serve(() =>
      pageOf([row(1, { amount: '3000', recordedAt: '2026-10-14T13:30:00.000Z' })], {
        currency: 'JPY',
      }),
    );
    mount({ zone: 'Pacific/Auckland', marketId: 'JP', currency: 'JPY' });
    await firstRow();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Occurred on' })).toBeTruthy();
    // Whole yen: no decimals, no dollars.
    expect(within(table).getByText(/3,000/).textContent).not.toMatch(/\$|\./);
    expect(within(table).getAllByText(/15 Oct/).length).toBeGreaterThan(0);
    expect(screen.getByText('Dates are shown in Pacific/Auckland.')).toBeTruthy();
    // The filter's amounts are whole yen, sent as they are.
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'minAmount' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: '100' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastParams()['minAmount']).toBe('100'));
  });
});
