// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast, Toaster } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { OrdersList } from './orders-list.tsx';
import { DEFAULT_QUERY, queryString, presetDays, sortIdOf } from './orders-query.ts';
import {
  payloadOf,
  problemOf,
  queryOf,
  type SavedFilter,
  type SavedFiltersAnswer,
} from './orders-saved.ts';
import messages from '../../messages/en.json';
import { order, part, wrap } from './orders-test-kit.tsx';
import { FILTERS, type AdminOrder, type AdminOrderPage, type AdminOrderRow } from './types.ts';

const call = vi.mocked(callApi);
const LIST = { accountId: '0190a000-0000-7000-8000-0000000000f1', marketId: 'AU' } as const;
const SAVED_PATH = 'ordering/admin/saved-filters';
const COLUMNS_KEY = 'mp:admin:AU:0190a000-0000-7000-8000-0000000000f1:orders-columns';
const OPEN = (name: string) => screen.getByRole('button', { name });

const row = (
  over: Partial<AdminOrder> = {},
  actions: string[] = ['open', 'copy-number'],
): AdminOrderRow => ({
  ...order(),
  ...over,
  actions,
});
const COUNTS = { pendingPayment: 3, confirmed: 20, cancelled: 2 };
const pageOf = (orders: AdminOrderRow[], over: Partial<AdminOrderPage> = {}): AdminOrderPage => ({
  orders,
  nextCursor: null,
  counts: COUNTS,
  total: null,
  paging: 'prev-next',
  hasNext: false,
  page: 1,
  pageSize: 25,
  searchCapped: false,
  searchScope: null,
  ...over,
});
const ok = (body: AdminOrderPage) => ({ ok: true as const, status: 200, body });
const savedFailure = { ok: false as const, failure: { status: 503, code: 'access.unavailable' } };

/** Answers the order list with `make(url)` and the saved filters with `savedBody`. */
function serve(make: (url: string) => AdminOrderPage, savedBody: unknown = savedFailure) {
  call.mockImplementation(((_method: string, path: string) => {
    if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedBody);
    return Promise.resolve(ok(make(path)));
  }) as never);
}
const lastUrl = (): string => {
  const calls = call.mock.calls.filter(([, path]) => path.startsWith('ordering/admin/orders'));
  return String(calls[calls.length - 1]?.[1]);
};
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);
const mount = (props: Partial<React.ComponentProps<typeof OrdersList>> = {}) =>
  render(wrap(<OrdersList {...LIST} zone="UTC" {...props} />));

beforeEach(() => {
  call.mockReset();
  push.mockReset();
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('orders list', () => {
  it('lists the orders with reference, status, sellers, customer and total', async () => {
    serve(() =>
      pageOf([
        row(),
        row({
          orderId: '0190a000-0000-7000-8000-000000000002',
          status: 'pending-payment',
          confirmedAt: null,
          sellerOrders: [
            part(),
            part({
              sellerId: '0190a000-0000-7000-8000-0000000000a2',
              storeName: 'Al Noor Butchery',
            }),
          ],
          customer: { displayName: 'Amira Haddad', email: 'amira@example.com' },
          total: { amount: '5000', currency: 'AUD' },
        }),
      ]),
    );
    mount();
    const table = await screen.findByRole('table');
    const link = within(table).getByRole('link', { name: 'Order 00000001' });
    expect(link.getAttribute('href')).toBe('/orders/0190a000-0000-7000-8000-000000000001');
    // "Paid" is the status badge: the Paid column is off until the admin shows it.
    expect(within(table).getAllByText('Paid')).toHaveLength(1);
    expect(within(table).getByText('Awaiting payment')).toBeTruthy();
    expect(within(table).getByText('$25.00')).toBeTruthy();
    expect(within(table).getByText('$50.00')).toBeTruthy();
    expect(within(table).getByText('Amira Haddad')).toBeTruthy();
    expect(within(table).getByText('Al Noor Butchery')).toBeTruthy();
    // The first page asks for page mode with Previous and next, newest first.
    expect(paramsOf(lastUrl())).toEqual({
      page: '1',
      pageSize: '25',
      paging: 'prev-next',
      sort: 'created',
      direction: 'desc',
    });
  });

  it('offers exactly the statuses the admin API accepts, with their counts', async () => {
    expect(FILTERS).toEqual(['all', 'pending-payment', 'confirmed', 'cancelled']);
    serve(() => pageOf([]));
    mount();
    await screen.findByText('No orders yet');
    const tabs = within(screen.getByRole('navigation', { name: 'Order statuses' })).getAllByRole(
      'button',
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'All (25)',
      'Awaiting payment (3)',
      'Paid (20)',
      'Cancelled (2)',
    ]);
  });

  it('filters by status and says which status is empty', async () => {
    serve((url) => pageOf(paramsOf(url)['status'] === 'cancelled' ? [] : [row()]));
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /^Cancelled/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBe('cancelled'));
    expect(await screen.findByText('No cancelled orders')).toBeTruthy();
  });

  it('pages with Previous and Next from the API hasNext, no total', async () => {
    serve((url) =>
      pageOf([row({ orderId: `0190a000-0000-7000-8000-00000000000${paramsOf(url)['page']}` })], {
        hasNext: paramsOf(url)['page'] === '1',
        page: Number(paramsOf(url)['page']),
      }),
    );
    mount();
    await screen.findByRole('link', { name: 'Order 00000001' });
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.getByText('Sorted by Placed: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('link', { name: 'Order 00000002' })).toBeTruthy();
    expect(paramsOf(lastUrl())['page']).toBe('2');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByRole('link', { name: 'Order 00000001' });
    expect(paramsOf(lastUrl())['page']).toBe('1');
  });

  it('shows page numbers with the total, the range and the 10,000 row limit', async () => {
    serve((url) =>
      pageOf([row()], {
        total: 12_345,
        paging: 'pages',
        page: Number(paramsOf(url)['page']),
      }),
    );
    mount({ paging: 'pages' });
    await screen.findByRole('table');
    expect(paramsOf(lastUrl())['paging']).toBe('pages');
    expect(screen.getByText('1 to 1 of 12345'.replace('12345', '12,345'))).toBeTruthy();
    expect(screen.getByText(/Page numbers stop at the first 10,000 orders/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 400' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Page 401' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('2'));
    // The focus moves from the pager to the top of the new rows.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('table').parentElement?.parentElement),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Cancelled/ }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ status: 'cancelled', page: '1' }),
    );
  });

  it('shows the error with a retry that loads again, and never retries a refused query', async () => {
    call.mockImplementation(((_m: string, path: string) =>
      Promise.resolve(
        path.startsWith(SAVED_PATH)
          ? savedFailure
          : { ok: false, failure: { status: 503, code: 'access.unavailable' } },
      )) as never);
    mount();
    expect(await screen.findByText(/couldn't load the orders/)).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    cleanup();
    call.mockImplementation(((_m: string, path: string) =>
      Promise.resolve(
        path.startsWith(SAVED_PATH)
          ? savedFailure
          : { ok: false, failure: { status: 400, code: 'validation.failed' } },
      )) as never);
    mount();
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('writes the times on the clock of the zone and names the zone', async () => {
    serve(() => pageOf([row({ createdAt: '2026-10-12T15:30:00.000Z' })]));
    mount({ zone: 'Australia/Brisbane' });
    const table = await screen.findByRole('table');
    expect(screen.getByText('Times and days are in Australia/Brisbane.')).toBeTruthy();
    expect(within(table).getByText(/13 Oct.*1:30/)).toBeTruthy();
  });
});

describe('orders list search, filters and sort', () => {
  async function applyFilter(field: string, value: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: field } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  }

  it('sends an order id as q and a name as search, and says when the text is too short', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByRole('table');
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'Al Noor' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe('Al Noor'));
    expect(screen.getByText('Search: "Al Noor"')).toBeTruthy();
    fireEvent.change(box, { target: { value: '0190A000-0000-7000-8000-000000000001' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ q: '0190a000-0000-7000-8000-000000000001' }),
    );
    expect(paramsOf(lastUrl())['search']).toBeUndefined();
    const calls = call.mock.calls.length;
    fireEvent.change(box, { target: { value: 'a' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Type at least 2 characters.')).toBeTruthy();
    expect(call.mock.calls.length).toBe(calls);
  });

  it('says only store names were searched, and that a search was cut', async () => {
    serve(() => pageOf([row()], { searchScope: 'stores', searchCapped: true }));
    mount();
    await screen.findByRole('table');
    expect(screen.getByText(/Only store names were searched/)).toBeTruthy();
    expect(screen.getByText(/More than 200 customers or stores match/)).toBeTruthy();
  });

  it('filters by payment, fulfilment and a placed preset, as chips that can be removed', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByRole('table');
    await applyFilter('paymentState', 'captured');
    await waitFor(() => expect(paramsOf(lastUrl())['paymentState']).toBe('captured'));
    expect(screen.getByText('Payment is Captured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(within(panel).getAllByLabelText('Field')[1]!, {
      target: { value: 'fulfilment' },
    });
    fireEvent.change(within(panel).getAllByLabelText('Value')[1]!, {
      target: { value: 'shipped' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({
        paymentState: 'captured',
        fulfilment: 'shipped',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Payment is Captured' }));
    await waitFor(() => expect(paramsOf(lastUrl())['paymentState']).toBeUndefined());
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())['fulfilment']).toBeUndefined());
  });

  it('reads a placed preset on the clock of the zone, the last day included', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T20:30:00.000Z'));
    try {
      serve(() => pageOf([row()]));
      mount({ zone: 'Australia/Brisbane' });
      await screen.findByRole('table');
      await applyFilter('placed', 'today');
      // 17 Nov in Brisbane runs from 16 Nov 14:00 UTC to 17 Nov 14:00 UTC.
      await waitFor(() =>
        expect(paramsOf(lastUrl())).toMatchObject({
          from: '2026-11-16T14:00:00.000Z',
          to: '2026-11-17T14:00:00.000Z',
        }),
      );
      expect(screen.getByText('Placed is Today')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sorts by total from the Sort panel and names the sort', async () => {
    serve(() => pageOf([row()], { total: 1, paging: 'pages' }));
    mount({ paging: 'pages' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Total' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=total&direction=desc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Lowest first' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=total&direction=asc'));
    expect(screen.getByText('Sorted by Total: Lowest first')).toBeTruthy();
  });

  it('shows the empty state of a filter with a way to clear it', async () => {
    serve((url) => pageOf(paramsOf(url)['paymentState'] === undefined ? [row()] : []));
    mount();
    await screen.findByRole('table');
    await applyFilter('paymentState', 'voided');
    expect(await screen.findByText('No orders match')).toBeTruthy();
  });
});

describe('orders list selection, actions and bulk', () => {
  it('selects rows and offers Select all matching', async () => {
    serve(() => pageOf([row()], { hasNext: true }));
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    expect(screen.getByText('1 order selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching orders are selected')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Bulk action' }).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('puts every row action in the Actions menu, exactly as the API names them', async () => {
    serve(() =>
      pageOf([
        row({}, ['open', 'print-document', 'copy-number', 'add-note', 'refund', 'cancel', 'merge']),
      ]),
    );
    mount();
    await screen.findByRole('table');
    // No action button sits in the row itself: only the menu button.
    expect(screen.getAllByRole('button', { name: /^Actions for order/ })).toHaveLength(1);
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Open order',
      'Print document',
      'Copy order number',
      'Add note…',
      'Refund…',
      'Cancel order…',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Cancel order…' }));
    expect(push).toHaveBeenCalledWith('/orders/0190a000-0000-7000-8000-000000000001?do=cancel');
  });

  it('offers only the actions a row names, and none when it names none', async () => {
    serve(() => pageOf([row({}, ['open'])]));
    mount();
    await screen.findByRole('table');
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open order' }));
    expect(push).toHaveBeenCalledWith('/orders/0190a000-0000-7000-8000-000000000001');
  });

  it('copies the order number and says so, or says it could not', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve(() => pageOf([row()]));
    render(
      wrap(
        <>
          <OrdersList {...LIST} zone="UTC" />
          <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
        </>,
      ),
    );
    await screen.findByRole('table');
    fireEvent.click(OPEN('Actions for order 00000001'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy order number' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('0190a000-0000-7000-8000-000000000001'),
    );
    expect(await screen.findByText('Copied')).toBeTruthy();
    toast.dismiss();
  });
});

describe('order list columns', () => {
  it('shows the default columns until the admin chooses', async () => {
    serve(() => pageOf([row()]));
    mount();
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(
      expect.arrayContaining(['Order', 'Status', 'Placed', 'Customer', 'Sellers', 'Total']),
    );
    expect(within(table).queryByRole('columnheader', { name: 'Paid' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Payment' })).toBeNull();
  });

  it('shows the Paid column, with "Not yet" for an unpaid order, once the admin turns it on', async () => {
    serve(() => pageOf([row({ status: 'pending-payment', confirmedAt: null })]));
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Paid' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Paid' })).toBeTruthy();
    expect(within(table).getByText('Not yet')).toBeTruthy();
  });

  it('keeps the choice in this browser, in the chosen order, and reads it back', async () => {
    serve(() => pageOf([row()]));
    const first = mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    for (const name of ['Placed', 'Customer', 'Sellers']) {
      fireEvent.click(within(panel).getByRole('checkbox', { name }));
    }
    fireEvent.click(within(panel).getByRole('button', { name: 'Move Total up' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    const headers = () =>
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
        .filter((name) => name !== '' && name !== 'Actions');
    expect(headers()).toEqual(['Order', 'Status', 'Total']);
    expect(window.localStorage.getItem(COLUMNS_KEY)).toBe('["total"]');
    first.unmount();
    mount();
    await screen.findByRole('table');
    await waitFor(() => expect(headers()).toEqual(['Order', 'Status', 'Total']));
  });

  it("scopes a customer's Orders tab to them, keeps its own columns and has no Customer column", async () => {
    const CUSTOMER = '0190a000-0000-7000-8000-0000000000c1';
    window.localStorage.setItem(COLUMNS_KEY, '["customer","total"]');
    serve(() => pageOf([row()]));
    mount({ customerAccountId: CUSTOMER });
    const table = await screen.findByRole('table');
    const asked = call.mock.calls.map((args) => args[1]);
    expect(
      asked.some((path) => path.startsWith(`ordering/admin/orders?accountId=${CUSTOMER}&`)),
    ).toBe(true);
    // No saved filters on a customer's tab: they belong to the Orders page.
    expect(asked.some((path) => path.startsWith(SAVED_PATH))).toBe(false);
    const shown = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(shown).not.toContain('Customer');
    expect(shown).toContain('Total');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    expect(within(panel).queryByRole('checkbox', { name: 'Customer' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    // The Orders page's choice is untouched; the tab keeps its own.
    expect(window.localStorage.getItem(COLUMNS_KEY)).toBe('["customer","total"]');
    expect(
      window.localStorage.getItem(
        'mp:admin:AU:0190a000-0000-7000-8000-0000000000f1:customer-orders-columns',
      ),
    ).not.toContain('"customer"');
    // Each order links back to this customer's Orders tab.
    expect(within(table).getAllByRole('link')[0]?.getAttribute('href')).toContain(
      `customer=${CUSTOMER}&from=orders`,
    );
    // So does the row's Actions menu (Open order here; Cancel, notes and refunds alike).
    fireEvent.click(within(table).getAllByRole('button', { name: /^Actions for / })[0]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open order' }));
    expect(push).toHaveBeenLastCalledWith(
      `/orders/${row().orderId}?customer=${CUSTOMER}&from=orders`,
    );
  });

  it('ignores a stored column that no longer exists, and works when storage refuses', async () => {
    window.localStorage.setItem(COLUMNS_KEY, '["margin","paid","status","paid"]');
    serve(() => pageOf([row()]));
    mount();
    const table = await screen.findByRole('table');
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((h) => h.textContent)
          .filter((name) => name !== '' && name !== 'Actions'),
      ).toEqual(['Order', 'Status', 'Paid']),
    );
    cleanup();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Sellers' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(
      within(screen.getByRole('table')).queryByRole('columnheader', { name: 'Sellers' }),
    ).toBeNull();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

const saved = (over: Partial<SavedFilter> = {}): SavedFilter => ({
  id: '0190a000-0000-7000-8000-0000000000aa',
  listKey: 'admin.ordering.orders',
  name: 'Paid, captured',
  visibility: 'me',
  payload: {
    v: 1,
    tab: 'confirmed',
    filters: { paymentState: 'captured', from: '2026-11-01', to: '2026-11-05' },
    sort: 'total-high',
  },
  ownedByMe: true,
  canManage: true,
  createdAt: '2026-11-06T00:00:00Z',
  updatedAt: '2026-11-06T00:00:00Z',
  ...over,
});
const savedAnswer = (items: SavedFilter[], canShare = false) => ({
  ok: true as const,
  status: 200,
  body: { items, canShare, limits: { perOwner: 50, shared: 20 } } satisfies SavedFiltersAnswer,
});

describe('order list saved filters', () => {
  it('opens a saved tab with its tab, filters, days and sort', async () => {
    serve(() => pageOf([row()]), savedAnswer([saved()]));
    mount({ paging: 'pages' });
    await screen.findByRole('table');
    const tab = await screen.findByRole('button', { name: 'Paid, captured' });
    fireEvent.click(tab);
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({
        status: 'confirmed',
        paymentState: 'captured',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-06T00:00:00.000Z',
        sort: 'total',
        direction: 'desc',
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Paid, captured' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText('Placed is 2026-11-01 to 2026-11-05')).toBeTruthy();
  });

  it('never carries the saved filter over to a built-in tab (john: a saved filter belongs to its tab)', async () => {
    serve(() => pageOf([row()]), savedAnswer([saved()]));
    mount({ paging: 'pages' });
    fireEvent.click(await screen.findByRole('button', { name: 'Paid, captured' }));
    await waitFor(() => expect(paramsOf(lastUrl())['paymentState']).toBe('captured'));
    fireEvent.click(screen.getByRole('button', { name: /^Cancelled/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBe('cancelled'));
    expect(paramsOf(lastUrl())).toEqual({
      status: 'cancelled',
      page: '1',
      pageSize: '25',
      paging: 'pages',
      sort: 'created',
      direction: 'desc',
    });
    expect(screen.queryByText(/Payment is/)).toBeNull();
    expect(screen.queryByText(/Placed is/)).toBeNull();
  });

  it('leaves the saved tab as soon as a filter or the sort changes', async () => {
    serve(() => pageOf([row()], { total: 1, paging: 'pages' }), savedAnswer([saved()]));
    mount({ paging: 'pages' });
    fireEvent.click(await screen.findByRole('button', { name: 'Paid, captured' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Paid, captured' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Lowest first' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Paid, captured' }).getAttribute('aria-pressed'),
      ).toBe('false'),
    );
    expect(screen.getByRole('button', { name: 'Save filter…' })).toBeTruthy();
  });

  it('does not ask when a saved range ends before it starts, and says no order matches', async () => {
    serve(
      () => pageOf([row()]),
      savedAnswer([
        saved({ payload: { v: 1, tab: 'all', filters: { from: '2026-10-10', to: '2026-10-01' } } }),
      ]),
    );
    mount();
    await screen.findByRole('table');
    const asked = call.mock.calls.filter(([, p]) => p.startsWith('ordering/admin/orders')).length;
    fireEvent.click(await screen.findByRole('button', { name: 'Paid, captured' }));
    expect(await screen.findByText('No orders match')).toBeTruthy();
    expect(call.mock.calls.filter(([, p]) => p.startsWith('ordering/admin/orders')).length).toBe(
      asked,
    );
  });

  it('saves the current filters as a private filter and shows it as the open tab', async () => {
    let items: SavedFilter[] = [];
    call.mockImplementation(((method: string, path: string, body?: unknown) => {
      if (path.startsWith(SAVED_PATH) && method === 'POST') {
        const sent = body as { name: string; payload: SavedFilter['payload'] };
        items = [saved({ name: sent.name, payload: sent.payload })];
        return Promise.resolve({ ok: true, status: 201, body: items[0] });
      }
      if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedAnswer(items));
      return Promise.resolve(ok(pageOf([row()], { total: 1, paging: 'pages' })));
    }) as never);
    mount({ paging: 'pages', csrfToken: 'csrf-1' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const filter = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(filter).getByLabelText('Field'), { target: { value: 'paymentState' } });
    fireEvent.change(within(filter).getByLabelText('Value'), { target: { value: 'captured' } });
    fireEvent.click(within(filter).getByRole('button', { name: 'Apply' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    expect(within(dialog).getByText(/Payment is Captured/)).toBeTruthy();
    expect(
      within(dialog).getByText('Saved for you only. Your role can’t share filters.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: ' Big captured ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'Big captured' });
    expect(call).toHaveBeenCalledWith(
      'POST',
      'ordering/admin/saved-filters',
      {
        listKey: 'admin.ordering.orders',
        name: 'Big captured',
        visibility: 'me',
        payload: { v: 1, tab: 'all', filters: { paymentState: 'captured' } },
      },
      'csrf-1',
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Big captured' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  it('does not offer Save filter without anything to save, or when the filters cannot load', async () => {
    serve(() => pageOf([row()]), savedAnswer([]));
    const first = mount();
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    first.unmount();
    serve(() => pageOf([row()]));
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /^Paid/ }));
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });

  it('manages filters: renames, and deletes after asking once', async () => {
    let items = [
      saved(),
      saved({
        id: '0190a000-0000-7000-8000-0000000000ab',
        name: 'Shared by Sam',
        visibility: 'everyone',
        ownedByMe: false,
        canManage: false,
      }),
    ];
    call.mockImplementation(((method: string, path: string, body?: unknown) => {
      if (path.startsWith(SAVED_PATH) && method === 'PUT') {
        items = [{ ...items[0]!, name: (body as { name: string }).name }, items[1]!];
        return Promise.resolve({ ok: true, status: 200, body: items[0] });
      }
      if (path.startsWith(SAVED_PATH) && method === 'DELETE') {
        items = items.slice(1);
        return Promise.resolve({ ok: true, status: 200, body: { id: 'x' } });
      }
      if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedAnswer(items));
      return Promise.resolve(ok(pageOf([row()])));
    }) as never);
    mount({ csrfToken: 'csrf-2' });
    await screen.findByRole('button', { name: 'Shared by Sam' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage filters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage filters' });
    expect(within(dialog).queryByRole('button', { name: 'Edit Shared by Sam' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Paid, captured' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Captured' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('button', { name: 'Captured' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Captured' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete filter' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Captured' })).toBeNull());
  });

  it("moves an own filter and saves the order of the admin's own filters, as tabs", async () => {
    const A = saved();
    const B = saved({ id: '0190a000-0000-7000-8000-0000000000ac', name: 'Big orders' });
    const THEIRS = saved({
      id: '0190a000-0000-7000-8000-0000000000ab',
      name: 'Shared by Sam',
      visibility: 'everyone',
      ownedByMe: false,
      canManage: false,
    });
    let items = [A, B, THEIRS];
    call.mockImplementation(((method: string, path: string) => {
      if (path === 'lists/admin/saved-filters/order') {
        items = [B, A, THEIRS];
        return Promise.resolve({ ok: true, status: 200, body: { ids: [B.id, A.id] } });
      }
      if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedAnswer(items));
      return Promise.resolve(ok(pageOf([row()])));
    }) as never);
    render(
      wrap(
        <>
          <OrdersList {...LIST} zone="UTC" csrfToken="csrf-2" />
          <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
        </>,
      ),
    );
    await screen.findByRole('button', { name: 'Big orders' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage filters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage filters' });
    expect(within(dialog).getByRole('button', { name: 'Move Paid, captured up' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(dialog).queryByRole('button', { name: 'Move Shared by Sam down' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Paid, captured down' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'lists/admin/saved-filters/order',
        { listKey: 'admin.ordering.orders', ids: [B.id, A.id] },
        'csrf-2',
      ),
    );
    expect(await screen.findByText('Moved “Paid, captured”')).toBeTruthy();
    // The tabs follow the new order.
    await waitFor(() => {
      const tabs = screen
        .getAllByRole('button')
        .map((button) => button.textContent ?? '')
        .filter((text) => text === 'Big orders' || text === 'Paid, captured');
      expect(tabs).toEqual(['Big orders', 'Paid, captured']);
    });
    toast.dismiss();
  });

  it('says a refused move in a banner, reads the filters again and keeps their order', async () => {
    const A = saved();
    const B = saved({ id: '0190a000-0000-7000-8000-0000000000ac', name: 'Big orders' });
    let reads = 0;
    call.mockImplementation(((method: string, path: string) => {
      if (path === 'lists/admin/saved-filters/order') {
        return Promise.resolve({
          ok: false,
          failure: {
            status: 422,
            code: 'validation.failed',
            details: { fields: [{ path: 'ids' }] },
          },
        });
      }
      if (path.startsWith(SAVED_PATH)) {
        reads += 1;
        return Promise.resolve(savedAnswer([A, B]));
      }
      return Promise.resolve(ok(pageOf([row()])));
    }) as never);
    mount({ csrfToken: 'csrf-2' });
    await screen.findByRole('button', { name: 'Big orders' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage filters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage filters' });
    const before = reads;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Paid, captured down' }));
    expect(await within(dialog).findByText(messages.orders.saved.error.unavailable)).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    const names = within(dialog)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(names[0]).toContain('Paid, captured');
  });
});

describe('order list query and saved documents', () => {
  const NOW = new Date('2026-11-16T20:30:00.000Z');
  const context = { paging: 'pages' as const, zone: 'UTC', now: NOW };

  it('asks for a page with the paging mode, sort and the filters', () => {
    expect(
      queryString(
        { ...DEFAULT_QUERY, tab: 'confirmed', q: 'Al Noor', filters: { paymentState: 'captured' } },
        context,
      ),
    ).toBe(
      'status=confirmed&paymentState=captured&search=Al+Noor&page=1&pageSize=25&paging=pages&sort=created&direction=desc',
    );
  });

  it('reads a custom range of days on the zone, the last day included, and a bad day not at all', () => {
    const query = { ...DEFAULT_QUERY, days: { from: '2026-10-01', to: '2026-10-31' } };
    expect(
      paramsOf(`x?${queryString(query, { ...context, zone: 'Australia/Brisbane' })}`),
    ).toMatchObject({
      from: '2026-09-30T14:00:00.000Z',
      to: '2026-10-31T14:00:00.000Z',
    });
    expect(queryString({ ...DEFAULT_QUERY, days: { from: 'x', to: 'y' } }, context)).not.toContain(
      'from=',
    );
  });

  it('turns a preset into the days it means, on the clock of the zone', () => {
    expect(presetDays('last-7-days', 'UTC', NOW)).toEqual({ from: '2026-11-10', to: '2026-11-16' });
    expect(presetDays('today', 'Australia/Brisbane', NOW)).toEqual({
      from: '2026-11-17',
      to: '2026-11-17',
    });
    expect(presetDays('last-month', 'UTC', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('round-trips the page state and leaves out what is empty', () => {
    const query = {
      ...DEFAULT_QUERY,
      tab: 'confirmed' as const,
      filters: { paymentState: 'captured' },
      days: { from: '2026-11-01', to: '2026-11-05' },
      sort: 'total' as const,
      direction: 'asc' as const,
    };
    const payload = payloadOf(query, 'UTC', NOW);
    expect(payload).toEqual({
      v: 1,
      tab: 'confirmed',
      filters: { paymentState: 'captured', from: '2026-11-01', to: '2026-11-05' },
      sort: 'total-low',
    });
    expect(queryOf(payload)).toEqual(query);
    expect(payloadOf(DEFAULT_QUERY, 'UTC', NOW)).toEqual({ v: 1, tab: 'all' });
    expect(queryOf({ v: 1, tab: 'all' })).toEqual(DEFAULT_QUERY);
    expect(sortIdOf('created', 'asc')).toBe('oldest');
  });

  it('saves a preset as the days it means today', () => {
    expect(payloadOf({ ...DEFAULT_QUERY, filters: { placed: 'last-7-days' } }, 'UTC', NOW)).toEqual(
      {
        v: 1,
        tab: 'all',
        filters: { from: '2026-11-10', to: '2026-11-16' },
      },
    );
  });

  it('says what a refusal means', () => {
    expect(problemOf({ status: 409, code: 'saved-filter.name-taken' })).toBe('name-taken');
    expect(problemOf({ status: 409, code: 'saved-filter.limit-reached' })).toBe('limit');
    expect(problemOf({ status: 409, code: 'saved-filter.shared-limit-reached' })).toBe(
      'shared-limit',
    );
    expect(problemOf({ status: 403, code: 'access.denied' })).toBe('denied');
    expect(
      problemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'name', code: 'required' }] },
      }),
    ).toBe('name-empty');
    expect(problemOf({ status: 503, code: 'access.unavailable' })).toBe('unavailable');
  });
});

describe('orders export', () => {
  const CSV = { 'content-type': 'text/csv; charset=utf-8' };
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const click = vi.fn();
  const mountWithToasts = () =>
    render(
      wrap(
        <>
          <OrdersList {...LIST} zone="UTC" />
          <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
        </>,
      ),
    );
  /** Opens the export dialog of the ticked rows or, with `all`, of every matching order. */
  const openExport = async (all = false) => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    if (all) fireEvent.click(await screen.findByRole('button', { name: /^Select all .*matching/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Export/ }));
    return screen.findByRole('dialog');
  };
  const confirm = (dialog: HTMLElement, format: 'CSV' | 'XLSX' = 'CSV') => {
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(`^${format}`) }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
  };
  const answer = (make: () => Response) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(make()));
  const sent = (fetched: { mock: { calls: unknown[][] } }) => {
    const url = new URL(String(fetched.mock.calls[0]?.[0]), 'http://x');
    return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
  };

  beforeEach(() => {
    click.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:orders');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    toast.dismiss();
  });

  it('sends the filter, the shown columns and no paging after "Select all matching"', async () => {
    serve(() => pageOf([row()], { total: 60, hasNext: true }));
    mountWithToasts();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /^Paid/ }));
    await waitFor(() => expect(lastUrl()).toContain('status=confirmed'));
    await screen.findByRole('table');
    const dialog = await openExport(true);
    const fetched = answer(
      () =>
        new Response('Order\r\nrow\r\n', {
          status: 200,
          headers: {
            ...CSV,
            'content-disposition': 'attachment; filename="orders-2026-11-06.csv"',
          },
        }),
    );
    confirm(dialog);
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    const { path, params } = sent(fetched);
    expect(path).toBe('/api/ordering/admin/orders/export');
    expect(params['status']).toBe('confirmed');
    expect(params['format']).toBe('csv');
    // The default columns: Placed, Customer, Total and Sellers; the file adds what each stands for.
    expect(params['columns']).toBe('currency,total,tax,sellers,stores,fulfilment');
    for (const key of ['ids', 'page', 'pageSize', 'sort', 'direction', 'zone']) {
      expect(params).not.toHaveProperty(key);
    }
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('names the ticked orders and sends no filter', async () => {
    serve(() => pageOf([row()], { total: 60 }));
    mountWithToasts();
    await screen.findByRole('table');
    const dialog = await openExport();
    const fetched = answer(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { 'content-type': XLSX },
        }),
    );
    confirm(dialog, 'XLSX');
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    const { params } = sent(fetched);
    expect(params['format']).toBe('xlsx');
    expect(params['ids']).toBe(row().orderId);
    expect(params).not.toHaveProperty('status');
    expect(params).not.toHaveProperty('q');
  });

  it('tells the admin to narrow the filter when the file would be too large', async () => {
    serve(() => pageOf([row()], { total: 60, hasNext: true }));
    mountWithToasts();
    await screen.findByRole('table');
    const dialog = await openExport(true);
    answer(
      () =>
        new Response(
          JSON.stringify({ code: 'batch.too-large', details: { max: 10000, matching: 12345 } }),
          { status: 413 },
        ),
    );
    confirm(dialog);
    expect(await screen.findByText(/12,345 match, and one file holds up to 10,000/)).toBeTruthy();
    expect(click).not.toHaveBeenCalled();
  });

  it('says the export failed after any other failure', async () => {
    serve(() => pageOf([row()], { total: 60 }));
    mountWithToasts();
    await screen.findByRole('table');
    const dialog = await openExport();
    answer(() => new Response('{}', { status: 503 }));
    confirm(dialog);
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
  });

  it('keeps the Bulk action button off until a row is selected', async () => {
    serve(() => pageOf([], { total: 0 }));
    mountWithToasts();
    await screen.findByText(/No orders/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Bulk action' }).disabled).toBe(
      true,
    );
  });
});
