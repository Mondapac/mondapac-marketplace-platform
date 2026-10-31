// @vitest-environment jsdom
import { windowRange } from '../catalog/format.ts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { visibleNavItems } from '@mondapac/ui';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { orderProblemOf } from './errors.ts';
import { OrderDetail } from './order-detail.tsx';
import { SellerOrders } from './seller-orders.tsx';
import type { OrderLineView, SellerOrderPage, SellerOrderView } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const aud = (amount: string) => ({ amount, currency: 'AUD' });
const line = (over: Partial<OrderLineView> = {}): OrderLineView => ({
  lineId: '0190a000-0000-7000-8000-0000000000c1',
  offerId: '0190a000-0000-7000-8000-0000000000d1',
  variantId: '0190a000-0000-7000-8000-0000000000e1',
  productName: 'Aged Basmati Rice',
  variantLabel: '5 kg',
  quantity: 2,
  unitPrice: aud('1500'),
  lineAmount: aud('3000'),
  taxInclusive: true,
  ...over,
});
const order = (over: Partial<SellerOrderView> = {}): SellerOrderView => ({
  sellerOrderId: '0190a000-0000-7000-8000-0000000000a1',
  orderId: '0190a000-0000-7000-8000-0000000000b1',
  paidAt: '2026-10-14T10:00:00.000Z',
  subtotal: aud('3000'),
  shipping: aud('500'),
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
  lines: [line()],
  ...over,
});
const page = (orders: SellerOrderView[], nextCursor: string | null = null): SellerOrderPage => ({
  sellerOrders: orders,
  nextCursor,
});
const mountList = (initial = page([order()])) => render(wrap(<SellerOrders initial={initial} />));

const mountDetail = (
  initial = order(),
  { canMarkReady = true, canDeliver = true, canConfirmPickup = true } = {},
) =>
  render(
    wrap(
      <OrderDetail
        initial={initial}
        csrfToken="csrf"
        canMarkReady={canMarkReady}
        canDeliver={canDeliver}
        canConfirmPickup={canConfirmPickup}
      />,
    ),
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const shippedOrder = (over: Partial<SellerOrderView> = {}) =>
  order({
    fulfilment: 'shipped',
    carrier: 'Post',
    shippedAt: '2026-10-14T12:00:00.000Z',
    ...over,
  });

describe('SellerOrders list', () => {
  it('shows reference, status, paid date, item count and total', () => {
    mountList();
    expect(screen.getByRole('link', { name: /000000A1/ }).getAttribute('href')).toBe(
      '/orders/0190a000-0000-7000-8000-0000000000a1',
    );
    expect(screen.getAllByText('To ship').length).toBeGreaterThan(0);
    expect(screen.getByText('$35.00')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/14 Oct.*10:00 am/)).toBeTruthy();
    expect(screen.queryByText(/Delivery fee on every order/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark ready' })).toBeNull();
  });

  it('shows the paid time in the seller zone', () => {
    render(
      <NextIntlClientProvider locale="en-AU" timeZone="Australia/Brisbane" messages={messages}>
        <SellerOrders initial={page([order()])} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/14 Oct.*8:00 pm AEST/)).toBeTruthy();
  });

  it('says so when there is no order, with no filter', () => {
    mountList(page([]));
    expect(screen.getByRole('heading', { name: 'No paid orders yet' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Filter orders by fulfilment' })).toBeNull();
  });

  it('asks the API for the orders in a state, not only the loaded ones', async () => {
    const shipped = order({
      sellerOrderId: '0190a000-0000-7000-8000-0000000000a2',
      fulfilment: 'shipped',
    });
    call.mockResolvedValue({ ok: true, status: 200, body: page([shipped]) });
    mountList(page([order(), shipped], '1.cursor'));
    expect(screen.getAllByRole('link', { name: /^#/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Shipped' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^#/ })).toHaveLength(1));
    expect(call.mock.calls[0]?.[1]).toBe('ordering/seller/orders?limit=20&status=shipped');
    expect(screen.getByRole('link', { name: /000000A2/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more orders' })).toBeNull();
  });

  it('keeps the state in "Show more" and shows an empty state when a state has no orders', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: page([]) });
    mountList(page([order()], '1.cursor'));
    fireEvent.click(screen.getByRole('button', { name: 'Delivered' }));
    expect(await screen.findByRole('heading', { name: 'No orders in this state' })).toBeTruthy();
    expect(screen.queryByText(/Show more orders to look further back/)).toBeNull();
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: page([order({ fulfilment: 'delivered' })], '2.cursor'),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Shipped' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Show more orders' });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: page([]) });
    fireEvent.click(screen.getByRole('button', { name: 'Show more orders' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2]?.[1]).toBe(
      'ordering/seller/orders?limit=20&status=shipped&cursor=2.cursor',
    );
  });

  it('keeps the list and says so when a state cannot be loaded', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'x' } });
    mountList(page([order()]));
    fireEvent.click(screen.getByRole('button', { name: 'Shipped' }));
    expect(await screen.findByText(/Orders are not available right now/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /^#/ })).toHaveLength(1);
  });

  it('loads the next page by cursor and skips an order it already shows', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: page([order(), order({ sellerOrderId: '0190a000-0000-7000-8000-0000000000a2' })]),
    });
    mountList(page([order()], '1.cursor'));
    fireEvent.click(screen.getByRole('button', { name: 'Show more orders' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[1]).toBe('ordering/seller/orders?limit=20&cursor=1.cursor');
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^#/ })).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Show more orders' })).toBeNull();
  });

  it('says so when the next page cannot be loaded', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'x' } });
    mountList(page([order()], '1.cursor'));
    fireEvent.click(screen.getByRole('button', { name: 'Show more orders' }));
    expect(await screen.findByText(/Orders are not available right now/)).toBeTruthy();
  });
});

describe('OrderDetail', () => {
  it('shows the product name and variant for a line, its money and the totals', () => {
    mountDetail();
    expect(screen.getByRole('heading', { level: 1, name: /Order #000000A1/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to orders' }).getAttribute('href')).toBe(
      '/orders',
    );
    expect(screen.getByText('Aged Basmati Rice · 5 kg')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy();
    expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$35.00')).toBeTruthy();
    expect(screen.getByText('Paid 14 Oct 2026, 10:00 am UTC · 2 items')).toBeTruthy();
  });

  it('shows times in the seller zone the provider carries', () => {
    render(
      <NextIntlClientProvider locale="en-AU" timeZone="Australia/Brisbane" messages={messages}>
        <OrderDetail initial={order()} csrfToken="csrf" canMarkReady={true} canDeliver={true} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/^Paid 14 Oct 2026, 8:00 pm AEST · 2 items$/)).toBeTruthy();
  });

  it('shows the product name alone for a line with no variant label', () => {
    mountDetail(order({ lines: [line({ variantLabel: null })] }));
    expect(screen.getByText('Aged Basmati Rice')).toBeTruthy();
    expect(screen.queryByText(/·/, { selector: 'div' })).toBeNull();
  });

  it('treats a blank variant label as none', () => {
    mountDetail(order({ lines: [line({ variantLabel: '  ' })] }));
    expect(screen.getByText('Aged Basmati Rice')).toBeTruthy();
  });

  it('falls back to a short id for a line the API could not name', () => {
    mountDetail(order({ lines: [line({ productName: null, variantLabel: null })] }));
    expect(screen.getByText('Item 000000D1')).toBeTruthy();
  });

  it('shows each line of an order with its own name and variant', () => {
    mountDetail(
      order({
        lines: [
          line(),
          line({
            lineId: '0190a000-0000-7000-8000-0000000000c2',
            offerId: '0190a000-0000-7000-8000-0000000000d2',
            productName: 'Red Split Lentils',
            variantLabel: null,
          }),
        ],
      }),
    );
    expect(screen.getByText('Aged Basmati Rice · 5 kg')).toBeTruthy();
    expect(screen.getByText('Red Split Lentils')).toBeTruthy();
  });

  it('shows money and dates in a second Market (NZD, en-NZ, Pacific/Auckland)', () => {
    const nzd = (amount: string) => ({ amount, currency: 'NZD' });
    render(
      <NextIntlClientProvider locale="en-NZ" timeZone="Pacific/Auckland" messages={messages}>
        <OrderDetail
          initial={order({
            subtotal: nzd('3000'),
            shipping: nzd('500'),
            total: nzd('3500'),
            lines: [line({ unitPrice: nzd('1500'), lineAmount: nzd('3000') })],
          })}
          csrfToken="csrf"
          canMarkReady={true}
          canDeliver={true}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Aged Basmati Rice · 5 kg')).toBeTruthy();
    expect(screen.getByText('$35.00')).toBeTruthy();
    expect(screen.getByText(/^Paid 14 Oct 2026, 11:00 pm NZDT · 2 items$/)).toBeTruthy();
  });

  it('has one action on a paid order, "Mark ready", and no carrier or tracking form', () => {
    mountDetail();
    expect(screen.getByRole('button', { name: 'Mark ready' })).toBeTruthy();
    expect(screen.queryByLabelText('Carrier')).toBeNull();
    expect(screen.queryByLabelText(/Tracking reference/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as shipped' })).toBeNull();
    expect(screen.getByText('Delivery chosen by the customer')).toBeTruthy();
    expect(screen.getByText('Instant, under 2 hours')).toBeTruthy();
  });

  it('marks the order ready with an empty body, then shows it as ready and arranged by MondaPac', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: order({ readyAt: '2026-10-14T11:00:00.000Z' }),
    });
    mountDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'ordering/seller/orders/0190a000-0000-7000-8000-0000000000a1/ready',
      {},
      'csrf',
    );
    expect(await screen.findByText('Ready', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText(/You marked this order ready 14 Oct.*11:00 am/)).toBeTruthy();
    expect(screen.getByText(/MondaPac is arranging the delivery/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark ready' })).toBeNull();
    // Focus moves to the announced result instead of being lost with the button.
    const result = screen.getByRole('status');
    expect(result.textContent).toMatch(/You marked this order ready/);
    expect(document.activeElement).toBe(result);
  });

  it('describes the button by its hint and calls the order awaiting the shop', () => {
    mountDetail();
    const button = screen.getByRole('button', { name: 'Mark ready' });
    const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe(
      "Tell MondaPac this order is packed. MondaPac chooses the courier and delivers it, so you don't need to.",
    );
    expect(screen.getByText('Awaiting you', { selector: 'span' })).toBeTruthy();
  });

  it('spells a window out in full when it crosses midnight', () => {
    expect(
      windowRange(
        '2026-10-16T13:00:00.000Z',
        '2026-10-16T15:00:00.000Z',
        'en-AU',
        'Australia/Sydney',
      ),
    ).toMatch(/^17 Oct, 12:00\D+2:00\s+am AEDT$/);
    expect(
      windowRange(
        '2026-10-16T12:00:00.000Z',
        '2026-10-16T15:00:00.000Z',
        'en-AU',
        'Australia/Sydney',
      ),
    ).toMatch(/^16 Oct, 11:00\s+pm\D+17 Oct, 2:00\s+am AEDT$/);
  });

  it('tells a seller of a pickup order that the customer collects it', () => {
    mountDetail(order({ deliveryMethod: 'pickup', readyAt: '2026-10-14T11:00:00.000Z' }));
    expect(screen.getByText('Pickup in person')).toBeTruthy();
    expect(screen.getByText(/The customer collects it from you in person/)).toBeTruthy();
    expect(screen.queryByText(/arranging the delivery/)).toBeNull();
  });

  it('shows a scheduled window in the seller zone and never asks the seller to deliver when no carrier is found', () => {
    render(
      <NextIntlClientProvider locale="en-AU" timeZone="Australia/Brisbane" messages={messages}>
        <OrderDetail
          initial={order({
            deliveryMethod: 'scheduled',
            deliveryWindowStart: '2026-10-16T01:00:00.000Z',
            deliveryWindowEnd: '2026-10-16T03:00:00.000Z',
            readyAt: '2026-10-14T11:00:00.000Z',
            deliveryAttention: 'no-carrier',
          })}
          csrfToken="csrf"
          canMarkReady={true}
          canDeliver={true}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.getByText('Window')).toBeTruthy();
    // One day: the date once, the times collapsed, in the seller's zone (not UTC).
    expect(screen.getByText(/^16 Oct, 11:00\D+1:00\s+pm AEST$/)).toBeTruthy();
    expect(screen.queryByText(/UTC/)).toBeNull();
    expect(
      screen.getByText(
        'MondaPac is still assigning a courier. Keep the order packed and ready. No action needed.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows carrier, tracking and timestamps once shipped and marks it delivered', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: shippedOrder({ deliveredAt: '2026-10-15T01:00:00.000Z', fulfilment: 'delivered' }),
    });
    mountDetail(shippedOrder({ trackingRef: 'AP9' }));
    expect(screen.getByText('Post')).toBeTruthy();
    expect(screen.getByText('AP9')).toBeTruthy();
    expect(screen.getByText(/14 Oct.*12:00 pm/)).toBeTruthy();
    expect(screen.queryByText(/15 Oct.*1:00 am/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as delivered' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual([
      'POST',
      'ordering/seller/orders/0190a000-0000-7000-8000-0000000000a1/deliver',
      {},
    ]);
    expect(await screen.findByText(/15 Oct.*1:00 am/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as delivered' })).toBeNull();
  });

  it('shows a conflict in words and keeps the button', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'ordering.fulfilment-conflict' },
    });
    mountDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    expect(await screen.findByText(/already moved on/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark ready' })).toBeTruthy();
  });

  it('sends one request for a double click', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: order({ readyAt: '2026-10-14T11:00:00.000Z' }),
    });
    mountDetail();
    const button = screen.getByRole('button', { name: 'Mark ready' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  });

  it('shows a ready order as Ready in the list', () => {
    mountList(page([order({ readyAt: '2026-10-14T11:00:00.000Z' })]));
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
  });

  it('hides the actions without the permissions', () => {
    const { unmount } = mountDetail(order(), { canMarkReady: false, canDeliver: false });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('This order is not marked ready yet.')).toBeTruthy();
    unmount();
    mountDetail(shippedOrder(), { canMarkReady: false, canDeliver: false });
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('orderProblemOf and the nav', () => {
  it('names the problems and falls back by status', () => {
    expect(orderProblemOf({ status: 409, code: 'ordering.fulfilment-conflict' })).toBe('conflict');
    expect(orderProblemOf({ status: 404, code: 'ordering.seller-order-not-found' })).toBe(
      'not-found',
    );
    expect(orderProblemOf({ status: 503, code: 'x' })).toBe('unavailable');
    expect(orderProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });

  it('shows Orders only with the view permission', () => {
    const ids = (keys: string[]) =>
      visibleNavItems(sellerNav, new Set(keys)).map((item) => item.id);
    expect(ids(['ordering.seller-order.view'])).toContain('s_orders');
    expect(ids([])).not.toContain('s_orders');
  });
});

describe('Pickup handover', () => {
  const readyPickup = (over: Partial<SellerOrderView> = {}) =>
    order({
      deliveryMethod: 'pickup',
      readyAt: '2026-10-14T11:00:00.000Z',
      pickup: { attemptsLeft: 5, locked: false },
      ...over,
    });
  const boxes = () => screen.getAllByRole<HTMLInputElement>('textbox');
  const type = (code: string) =>
    [...code].forEach((digit, i) => fireEvent.change(boxes()[i]!, { target: { value: digit } }));

  it('shows four boxes and a Confirm button that stays off until the code is complete', () => {
    mountDetail(readyPickup());
    expect(boxes()).toHaveLength(4);
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm pickup' });
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText('5 tries left')).toBeTruthy();
    type('042');
    expect(confirm.disabled).toBe(true);
    type('0427');
    expect(confirm.disabled).toBe(false);
  });

  it('sends the code once and shows the order as handed over', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: readyPickup({
        fulfilment: 'delivered',
        shippedAt: '2026-10-14T12:00:00.000Z',
        deliveredAt: '2026-10-14T12:00:00.000Z',
        pickup: null,
      }),
    });
    mountDetail(readyPickup());
    type('0427');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pickup' }));
    await expectToast(/Handed over to the customer/);
    expect(call).toHaveBeenCalledWith(
      'POST',
      'ordering/seller/orders/0190a000-0000-7000-8000-0000000000a1/confirm-pickup',
      { code: '0427' },
      'csrf',
    );
    expect(screen.queryByRole('button', { name: 'Confirm pickup' })).toBeNull();
    expect(screen.queryByText('Carrier')).toBeNull();
  });

  it('spreads a pasted code over the boxes', () => {
    mountDetail(readyPickup());
    fireEvent.paste(boxes()[0]!, { clipboardData: { getData: () => '1 2-3 4' } });
    expect(boxes().map((box) => box.value)).toEqual(['1', '2', '3', '4']);
  });

  it('says a wrong code is wrong, how many tries are left, and clears the boxes', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 422, code: 'ordering.pickup-code-invalid', details: { attemptsLeft: 2 } },
    });
    mountDetail(readyPickup({ pickup: { attemptsLeft: 3, locked: false } }));
    type('9999');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pickup' }));
    await waitFor(() => expect(screen.getByText(/That code is not right/)).toBeTruthy());
    expect(screen.getAllByText(/2 tries left/)).toHaveLength(1);
    expect(
      screen.queryAllByRole('status').filter((node) => /tries left/.test(node.textContent ?? '')),
    ).toHaveLength(0);
    const banner = screen.getByText(/That code is not right/).closest('div[id]')!;
    for (const box of boxes()) {
      expect(box.getAttribute('aria-describedby')).toContain(banner.id);
    }
    expect(boxes().every((box) => box.value === '')).toBe(true);
  });

  it('locks the form when the API says the order is locked', () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 423, code: 'ordering.pickup-code-locked' },
    });
    mountDetail(readyPickup({ pickup: { attemptsLeft: 1, locked: true } }));
    expect(screen.getByText(/This order is locked/)).toBeTruthy();
    expect(screen.getByText(/old code stops working/)).toBeTruthy();
    expect(boxes().every((box) => box.disabled)).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm pickup' }).disabled).toBe(
      true,
    );
  });

  it('turns to locked after the fifth wrong code', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 423, code: 'ordering.pickup-code-locked' },
    });
    mountDetail(readyPickup({ pickup: { attemptsLeft: 1, locked: false } }));
    type('1111');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pickup' }));
    await waitFor(() => expect(screen.getByText(/This order is locked/)).toBeTruthy());
  });

  it('is hidden without the permission, before ready, and for other methods', () => {
    mountDetail(readyPickup(), { canConfirmPickup: false });
    expect(screen.queryByRole('button', { name: 'Confirm pickup' })).toBeNull();
    cleanup();
    mountDetail(readyPickup({ readyAt: null, pickup: null }));
    expect(screen.queryByRole('button', { name: 'Confirm pickup' })).toBeNull();
    cleanup();
    mountDetail(order({ readyAt: '2026-10-14T11:00:00.000Z' }));
    expect(screen.queryByRole('button', { name: 'Confirm pickup' })).toBeNull();
  });
});
