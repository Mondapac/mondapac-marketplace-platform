// @vitest-environment jsdom
import { Toaster, toast } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { SellerOrders } from './seller-orders.tsx';
import type { SavedFilter, SavedFiltersAnswer } from './orders-saved.ts';
import type { SellerOrderPage, SellerOrderRow } from './types.ts';

const call = vi.mocked(callApi);
const LIST = { accountId: '0190a000-0000-7000-8000-0000000000f1', marketId: 'AU' } as const;
const SAVED_PATH = 'ordering/seller/saved-filters';
const ORDERS_PATH = 'ordering/seller/orders';
const COLUMNS_KEY = 'mp:seller:AU:0190a000-0000-7000-8000-0000000000f1:orders-columns';
const ID1 = '0190a000-0000-7000-8000-0000000000a1';
const OPEN = (name: string) => screen.getByRole('button', { name });

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" timeZone="UTC" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const aud = (amount: string) => ({ amount, currency: 'AUD' });
const row = (
  over: Partial<SellerOrderRow> = {},
  actions: string[] = ['open', 'copy-number'],
): SellerOrderRow => ({
  sellerOrderId: ID1,
  orderId: '0190a000-0000-7000-8000-0000000000b1',
  paidAt: '2026-10-14T10:00:00.000Z',
  subtotal: aud('3000'),
  shipping: aud('500'),
  discount: aud('0'),
  shippingDiscount: aud('0'),
  total: aud('3500'),
  fulfilment: 'to-ship',
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  deliveryMethod: 'instant',
  deliveryWindowStart: null,
  deliveryWindowEnd: null,
  readyAt: null,
  deliveryAttention: null,
  lines: [
    {
      lineId: '0190a000-0000-7000-8000-0000000000c1',
      offerId: '0190a000-0000-7000-8000-0000000000d1',
      variantId: '0190a000-0000-7000-8000-0000000000e1',
      productName: 'Aged Basmati Rice',
      variantLabel: '5 kg',
      quantity: 2,
      unitPrice: aud('1500'),
      lineAmount: aud('3000'),
      discount: aud('0'),
      taxInclusive: true,
    },
  ],
  ...over,
  actions,
});
const COUNTS = { toShip: 3, shipped: 20, delivered: 2 };
const pageOf = (rows: SellerOrderRow[], over: Partial<SellerOrderPage> = {}): SellerOrderPage => ({
  sellerOrders: rows,
  nextCursor: null,
  counts: COUNTS,
  total: null,
  paging: 'prev-next',
  hasNext: false,
  page: 1,
  pageSize: 25,
  ...over,
});
const ok = (body: SellerOrderPage) => ({ ok: true as const, status: 200, body });
const savedFailure = { ok: false as const, failure: { status: 503, code: 'access.unavailable' } };

/** Answers the order list with `make(url)` and the saved filters with `savedBody`. */
function serve(make: (url: string) => SellerOrderPage, savedBody: unknown = savedFailure) {
  call.mockImplementation(((_method: string, path: string) => {
    if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedBody);
    return Promise.resolve(ok(make(path)));
  }) as never);
}
const lastUrl = (): string => {
  const calls = call.mock.calls.filter(([, path]) => path.startsWith(ORDERS_PATH));
  return String(calls[calls.length - 1]?.[1]);
};
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);
const mount = (
  initial: SellerOrderPage = pageOf([row()]),
  props: Partial<React.ComponentProps<typeof SellerOrders>> = {},
) => render(wrap(<SellerOrders initial={initial} {...LIST} {...props} />));

beforeEach(() => {
  call.mockReset();
  push.mockReset();
  window.localStorage.clear();
  serve(() => pageOf([row()]));
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('seller orders list', () => {
  it('shows reference, status, paid time, items and total from the page the server read', () => {
    mount();
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getByRole('link', { name: /000000A1/ })
        .getAttribute('href'),
    ).toBe(`/orders/${ID1}`);
    expect(within(table).getByText('$35.00')).toBeTruthy();
    expect(within(table).getByText('2')).toBeTruthy();
    expect(within(table).getByText(/14 Oct.*10:00 am/)).toBeTruthy();
    // The server's page is the first answer: the list asks for nothing more.
    expect(call.mock.calls.filter(([, p]) => p.startsWith(ORDERS_PATH))).toHaveLength(0);
  });

  it('says so when the shop has no order at all, with no filter', () => {
    mount(pageOf([], { counts: { toShip: 0, shipped: 0, delivered: 0 } }));
    expect(screen.getByRole('heading', { name: 'No paid orders yet' })).toBeTruthy();
  });

  it('offers the fulfilment tabs with their counts and asks for a tab by its status', async () => {
    mount();
    const tabs = within(screen.getByRole('navigation', { name: 'Filter orders by fulfilment' }))
      .getAllByRole('button')
      .map((tab) => tab.textContent);
    expect(tabs).toEqual(['All (25)', 'To ship (3)', 'Shipped (20)', 'Delivered (2)']);
    serve((url) => pageOf(paramsOf(url)['status'] === 'delivered' ? [] : [row()]));
    fireEvent.click(screen.getByRole('button', { name: /^Delivered/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBe('delivered'));
    expect(await screen.findByText('No orders in this state')).toBeTruthy();
  });

  it('pages with Previous and Next from the API hasNext, with no total', async () => {
    mount(pageOf([row()], { hasNext: true }));
    expect(screen.queryByText(/ of /)).toBeNull();
    serve((url) =>
      pageOf([row({ sellerOrderId: '0190a000-0000-7000-8000-0000000000a2' })], {
        page: Number(paramsOf(url)['page']),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('link', { name: /000000A2/ })).toBeTruthy();
    expect(paramsOf(lastUrl())).toMatchObject({ page: '2', paging: 'prev-next' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    serve(() => pageOf([row()], { hasNext: true, page: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByRole('link', { name: /000000A1/ });
    expect(paramsOf(lastUrl())['page']).toBe('1');
  });

  it('shows page numbers with the total, the range and the 10,000 row limit', async () => {
    mount(pageOf([row()], { total: 12_345, paging: 'pages' }), { paging: 'pages' });
    expect(screen.getByText('1 to 1 of 12,345')).toBeTruthy();
    expect(screen.getByText(/Page numbers stop at the first 10,000 orders/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 400' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Page 401' })).toBeNull();
    serve((url) =>
      pageOf([row()], { total: 12_345, paging: 'pages', page: Number(paramsOf(url)['page']) }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('2'));
  });

  it('keeps the rows and offers Try again when a page cannot be loaded, and never retries a refused query', async () => {
    mount();
    call.mockImplementation(((_m: string, path: string) =>
      Promise.resolve(
        path.startsWith(SAVED_PATH)
          ? savedFailure
          : { ok: false, failure: { status: 503, code: 'access.unavailable' } },
      )) as never);
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    expect(
      await screen.findByText(/Orders are not available right now|couldn't load/i),
    ).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    call.mockImplementation(((_m: string, path: string) =>
      Promise.resolve(
        path.startsWith(SAVED_PATH)
          ? savedFailure
          : { ok: false, failure: { status: 400, code: 'validation.failed' } },
      )) as never);
    fireEvent.click(screen.getByRole('button', { name: /^Delivered/ }));
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it("shows the paid time in the seller's zone", () => {
    render(
      <NextIntlClientProvider locale="en-AU" timeZone="Australia/Brisbane" messages={messages}>
        <SellerOrders initial={pageOf([row()])} {...LIST} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/14 Oct.*8:00 pm AEST/)).toBeTruthy();
    expect(screen.getByText('Times and days are in Australia/Brisbane.')).toBeTruthy();
  });
});

describe('seller orders search, filters and sort', () => {
  async function applyPreset(value: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'paid' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  }

  it('searches by a whole order id and says what to type for other text', async () => {
    mount();
    const box = screen.getByRole('searchbox', { name: 'Search orders' });
    fireEvent.change(box, { target: { value: ID1.toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(ID1));
    expect(screen.getByText(`Order: ${ID1.toUpperCase()}`)).toBeTruthy();
    const asked = call.mock.calls.length;
    fireEvent.change(box, { target: { value: 'rice' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Type a whole order ID/)).toBeTruthy();
    expect(call.mock.calls.length).toBe(asked);
  });

  it('reads a paid preset on the zone clock, the last day included, as a chip that can be removed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T20:30:00.000Z'));
    try {
      render(
        <NextIntlClientProvider locale="en-AU" timeZone="Australia/Brisbane" messages={messages}>
          <SellerOrders initial={pageOf([row()])} {...LIST} />
        </NextIntlClientProvider>,
      );
      await applyPreset('today');
      // 17 Nov in Brisbane runs from 16 Nov 14:00 UTC to 17 Nov 14:00 UTC.
      await waitFor(() =>
        expect(paramsOf(lastUrl())).toMatchObject({
          from: '2026-11-16T14:00:00.000Z',
          to: '2026-11-17T14:00:00.000Z',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Remove filter Paid is Today' }));
      await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeUndefined());
    } finally {
      vi.useRealTimers();
    }
  });

  it('sorts by total from the Sort panel and names the sort', async () => {
    mount(pageOf([row()], { total: 1, paging: 'pages' }), { paging: 'pages' });
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Total' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=total&direction=desc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Lowest first' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=total&direction=asc'));
    expect(screen.getByText('Sorted by Total, Lowest first')).toBeTruthy();
  });

  it('shows the empty state of a filter with a way to clear it', async () => {
    mount();
    serve(() => pageOf([]));
    await applyPreset('yesterday');
    expect(await screen.findByText('No orders match')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeUndefined());
  });
});

describe('seller orders selection, row actions and bulk', () => {
  it('selects rows, prints packing slips for them in a new tab, and not for "all matching"', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    mount(pageOf([row()], { hasNext: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all orders on this page' }));
    expect(screen.getByText('1 order selected')).toBeTruthy();
    fireEvent.click(OPEN('Bulk action'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Print packing slips/ }));
    expect(open).toHaveBeenCalledWith(`/orders/packing-slips?ids=${ID1}`, '_blank', 'noopener');
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching orders are selected')).toBeTruthy();
    fireEvent.click(OPEN('Bulk action'));
    expect(
      (
        await screen.findByRole<HTMLButtonElement>('menuitem', { name: /Print packing slips/ })
      ).getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('All matching orders are selected')).toBeNull();
    open.mockRestore();
  });

  it('stops ticking at 50 orders, the most one set of packing slips takes', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      row({ sellerOrderId: `0190a000-0000-7000-8000-${String(index).padStart(12, '0')}` }),
    );
    mount(pageOf(many, { pageSize: 100 }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all orders on this page' }));
    expect(screen.getByText('50 orders selected')).toBeTruthy();
  });

  it('puts every row action in the Actions menu, exactly as the API names them', async () => {
    mount(
      pageOf([
        row({}, ['open', 'packing-slip', 'copy-number', 'ready', 'report-unavailable', 'merge']),
      ]),
    );
    expect(screen.getAllByRole('button', { name: /^Actions for order/ })).toHaveLength(1);
    fireEvent.click(OPEN('Actions for order 000000A1'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Open',
      'Print packing slip',
      'Copy order ID',
      'Mark ready…',
      'Report unavailable…',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith(`/orders/${ID1}`);
  });

  it('asks before Mark ready, then marks the order and reads the page again', async () => {
    mount(pageOf([row({}, ['open', 'ready'])]));
    call.mockImplementation(((method: string, path: string) => {
      if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedFailure);
      if (method === 'POST') return Promise.resolve({ ok: true, status: 200, body: row() });
      return Promise.resolve(ok(pageOf([row()])));
    }) as never);
    fireEvent.click(OPEN('Actions for order 000000A1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark ready…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Mark order 000000A1 as ready\?/)).toBeTruthy();
    expect(call.mock.calls.some(([m]) => m === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark ready' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('POST', `ordering/seller/orders/${ID1}/ready`, {}, ''),
    );
    await waitFor(() => expect(lastUrl()).toContain('page=1'));
  });

  it('asks before Mark as delivered, then marks the order', async () => {
    mount(pageOf([row({ fulfilment: 'shipped' }, ['open', 'mark-delivered'])]));
    call.mockImplementation(((method: string, path: string) => {
      if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedFailure);
      if (method === 'POST') return Promise.resolve({ ok: true, status: 200, body: row() });
      return Promise.resolve(ok(pageOf([row()])));
    }) as never);
    fireEvent.click(OPEN('Actions for order 000000A1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as delivered…' }));
    const dialog = await screen.findByRole('dialog');
    expect(call.mock.calls.some(([m]) => m === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as delivered' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('POST', `ordering/seller/orders/${ID1}/deliver`, {}, ''),
    );
  });

  it('sends Hand over to the order page, where the pickup is confirmed', async () => {
    mount(pageOf([row({}, ['open', 'hand-over'])]));
    fireEvent.click(OPEN('Actions for order 000000A1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hand over…' }));
    expect(push).toHaveBeenCalledWith(`/orders/${ID1}`);
    expect(call.mock.calls.some(([m]) => m === 'POST')).toBe(false);
  });

  it('opens the report dialog for Report unavailable and sends nothing yet', async () => {
    mount(pageOf([row({}, ['open', 'report-unavailable'])]));
    fireEvent.click(OPEN('Actions for order 000000A1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Report unavailable…' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(call.mock.calls.some(([m]) => m === 'POST')).toBe(false);
  });

  it('copies the whole order ID, which the search accepts, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      wrap(
        <>
          <SellerOrders initial={pageOf([row()])} {...LIST} />
          <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
        </>,
      ),
    );
    fireEvent.click(OPEN('Actions for order 000000A1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy order ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ID1));
    expect(await screen.findByText('Order number copied')).toBeTruthy();
    toast.dismiss();
  });
});

describe('seller orders columns', () => {
  const heads = () =>
    within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((head) => head.textContent)
      .filter((name) => name !== '' && name !== 'Actions');

  it('shows the default columns until the seller chooses, then keeps the choice in this browser', async () => {
    mount();
    expect(heads()).toEqual(['Order', 'Status', 'Paid', 'Items', 'Total']);
    fireEvent.click(OPEN('Columns'));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Items' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(heads()).toEqual(['Order', 'Status', 'Paid', 'Total']);
    expect(JSON.parse(window.localStorage.getItem(COLUMNS_KEY) ?? 'null')).toEqual([
      'paid',
      'total',
    ]);
  });

  it('reads the stored choice and ignores unknown ids', async () => {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(['total', 'nope', 'paid']));
    mount();
    await waitFor(() => expect(heads()).toEqual(['Order', 'Status', 'Total', 'Paid']));
  });
});

const saved = (over: Partial<SavedFilter> = {}): SavedFilter => ({
  id: '0190a000-0000-7000-8000-0000000000aa',
  listKey: 'seller.ordering.orders',
  name: 'Old shipped',
  visibility: 'me',
  payload: {
    v: 1,
    tab: 'shipped',
    filters: { from: '2026-10-01', to: '2026-10-05' },
    sort: 'oldest',
  },
  ownedByMe: true,
  canManage: true,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...over,
});
const savedAnswer = (items: SavedFilter[], canShare = false) => ({
  ok: true as const,
  status: 200,
  body: { items, canShare, limits: { perOwner: 50, shared: 0 } } satisfies SavedFiltersAnswer,
});

describe('seller orders saved filters', () => {
  it('adds a tab for each saved filter and opens its tab, days and sort', async () => {
    serve(() => pageOf([row()]), savedAnswer([saved()]));
    mount(pageOf([row()], { total: 1, paging: 'pages' }), { paging: 'pages' });
    fireEvent.click(await screen.findByRole('button', { name: 'Old shipped' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({
        status: 'shipped',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-06T00:00:00.000Z',
        sort: 'paid',
        direction: 'asc',
      }),
    );
    expect(screen.getByRole('button', { name: 'Old shipped' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('Paid is 2026-10-01 to 2026-10-05')).toBeTruthy();
  });

  it('never carries a saved filter over to a built-in tab (john: a saved filter belongs to its own tab)', async () => {
    serve(() => pageOf([row()]), savedAnswer([saved()]));
    mount(pageOf([row()], { total: 1, paging: 'pages' }), { paging: 'pages' });
    fireEvent.click(await screen.findByRole('button', { name: 'Old shipped' }));
    await waitFor(() => expect(paramsOf(lastUrl())['direction']).toBe('asc'));
    fireEvent.click(screen.getByRole('button', { name: /^Delivered/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBe('delivered'));
    expect(paramsOf(lastUrl())).toEqual({
      status: 'delivered',
      page: '1',
      pageSize: '25',
      paging: 'pages',
      sort: 'paid',
      direction: 'desc',
    });
    expect(screen.queryByText(/Paid is/)).toBeNull();
  });

  it('leaves the saved tab as soon as the sort changes', async () => {
    serve(() => pageOf([row()], { total: 1, paging: 'pages' }), savedAnswer([saved()]));
    mount(pageOf([row()], { total: 1, paging: 'pages' }), { paging: 'pages' });
    fireEvent.click(await screen.findByRole('button', { name: 'Old shipped' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Old shipped' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    fireEvent.click(OPEN('Sort'));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Total' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Old shipped' }).getAttribute('aria-pressed')).toBe(
        'false',
      ),
    );
  });

  it('does not ask when a saved range ends before it starts, and says no order matches', async () => {
    serve(
      () => pageOf([row()]),
      savedAnswer([
        saved({ payload: { v: 1, tab: 'all', filters: { from: '2026-10-10', to: '2026-10-01' } } }),
      ]),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Old shipped' }));
    expect(await screen.findByText('No orders match')).toBeTruthy();
    expect(call.mock.calls.filter(([, p]) => p.startsWith(ORDERS_PATH))).toHaveLength(0);
  });

  it('saves the current tab and sort as a private filter and shows it as the open tab', async () => {
    let items: SavedFilter[] = [];
    call.mockImplementation(((method: string, path: string, body?: unknown) => {
      if (path.startsWith(SAVED_PATH) && method === 'POST') {
        const sent = body as { name: string; payload: SavedFilter['payload'] };
        items = [saved({ name: sent.name, payload: sent.payload })];
        return Promise.resolve({ ok: true, status: 201, body: items[0] });
      }
      if (path.startsWith(SAVED_PATH)) return Promise.resolve(savedAnswer(items));
      return Promise.resolve(ok(pageOf([row()])));
    }) as never);
    mount(pageOf([row()]), { csrfToken: 'csrf-1' });
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Sent ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'Sent' });
    expect(call).toHaveBeenCalledWith(
      'POST',
      'ordering/seller/saved-filters',
      {
        listKey: 'seller.ordering.orders',
        name: 'Sent',
        visibility: 'me',
        payload: { v: 1, tab: 'shipped' },
      },
      'csrf-1',
    );
  });

  it('offers neither Save filter nor Manage filters when the filters cannot load', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBe('shipped'));
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });
});

describe('seller orders export', () => {
  const CSV = { 'content-type': 'text/csv; charset=utf-8' };
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const click = vi.fn();
  const mountWithToasts = (page: SellerOrderPage) =>
    render(
      wrap(
        <>
          <SellerOrders initial={page} {...LIST} />
          <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
        </>,
      ),
    );
  /** Opens the export dialog: of the ticked row, of every matching order, or (neither) of the list. */
  const openExport = async (mode: 'ticked' | 'all' | 'list' = 'list') => {
    if (mode !== 'list') {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select all orders on this page' }));
    }
    if (mode === 'all')
      fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    fireEvent.click(OPEN('Bulk action'));
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

  it('sends the tab, the shown columns and no ids for the whole list', async () => {
    call.mockImplementation((_m: string, path: string) =>
      Promise.resolve(
        path.startsWith(SAVED_PATH) ? savedFailure : ok(pageOf([row()], { total: 60 })),
      ),
    );
    mountWithToasts(pageOf([row()], { total: 60 }));
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    await waitFor(() => expect(lastUrl()).toContain('status=shipped'));
    const dialog = await openExport();
    const fetched = answer(() => new Response('Order\r\nrow\r\n', { status: 200, headers: CSV }));
    confirm(dialog);
    expect(await screen.findByText('Exported 1 order.')).toBeTruthy();
    const { path, params } = sent(fetched);
    expect(path).toBe('/api/ordering/seller/orders/export');
    expect(params['status']).toBe('shipped');
    expect(params['format']).toBe('csv');
    // Paid, Items and Total are shown by default; the file adds what Total stands for and the steps.
    expect(params['columns']).toBe(
      'items,currency,subtotal,shipping,tax,total,carrier,tracking,ready,shipped,delivered',
    );
    for (const key of ['ids', 'page', 'pageSize', 'sort', 'direction', 'q']) {
      expect(params).not.toHaveProperty(key);
    }
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('names the ticked orders and sends no filter', async () => {
    mountWithToasts(pageOf([row()], { total: 60 }));
    const dialog = await openExport('ticked');
    const fetched = answer(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { 'content-type': XLSX },
        }),
    );
    confirm(dialog, 'XLSX');
    expect(await screen.findByText('Exported 1 order.')).toBeTruthy();
    const { params } = sent(fetched);
    expect(params['format']).toBe('xlsx');
    expect(params['ids']).toBe(ID1);
    expect(params).not.toHaveProperty('status');
  });

  it('exports the filter after "Select all matching", with no ids', async () => {
    mountWithToasts(pageOf([row()], { total: 60, hasNext: true }));
    const dialog = await openExport('all');
    const fetched = answer(() => new Response('Order\r\nrow\r\n', { status: 200, headers: CSV }));
    confirm(dialog);
    await screen.findByText('Exported 1 order.');
    expect(sent(fetched).params).not.toHaveProperty('ids');
  });

  it('tells the seller to narrow the filter when the file would be too large', async () => {
    mountWithToasts(pageOf([row()], { total: 60 }));
    const dialog = await openExport();
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

  it('says the export did not work after any other failure', async () => {
    mountWithToasts(pageOf([row()], { total: 60 }));
    const dialog = await openExport();
    answer(() => new Response('{}', { status: 503 }));
    confirm(dialog);
    expect(await screen.findByText('The export didn’t work. Try again.')).toBeTruthy();
  });

  it('offers no export with no rows', async () => {
    mountWithToasts(pageOf([], { total: 0 }));
    fireEvent.click(OPEN('Bulk action'));
    expect(
      (await screen.findByRole('menuitem', { name: /^Export/ })).getAttribute('aria-disabled'),
    ).toBe('true');
  });
});
