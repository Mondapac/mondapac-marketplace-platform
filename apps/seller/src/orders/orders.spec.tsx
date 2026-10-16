// @vitest-environment jsdom
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
import { variantLabelOf } from './labels.ts';
import { OrderDetail } from './order-detail.tsx';
import { SellerOrders } from './seller-orders.tsx';
import type { LineLabels, OwnFee, SellerOrderPage, SellerOrderView } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const aud = (amount: string) => ({ amount, currency: 'AUD' });
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
  lines: [
    {
      lineId: '0190a000-0000-7000-8000-0000000000c1',
      offerId: '0190a000-0000-7000-8000-0000000000d1',
      variantId: '0190a000-0000-7000-8000-0000000000e1',
      quantity: 2,
      unitPrice: aud('1500'),
      lineAmount: aud('3000'),
      taxInclusive: true,
    },
  ],
  ...over,
});
const page = (orders: SellerOrderView[], nextCursor: string | null = null): SellerOrderPage => ({
  sellerOrders: orders,
  nextCursor,
});
const fee: OwnFee = { sellerId: 's', amount: '500', currency: 'AUD' };

const labels: LineLabels = {
  '0190a000-0000-7000-8000-0000000000c1': { name: 'Aged Basmati Rice', variant: '5 kg' },
};

const mountList = (initial = page([order()]), flatFee: OwnFee | null = fee) =>
  render(wrap(<SellerOrders initial={initial} fee={flatFee} />));

const mountDetail = (
  initial = order(),
  { canShip = true, canDeliver = true, names = labels } = {},
) =>
  render(
    wrap(
      <OrderDetail
        initial={initial}
        labels={names}
        csrfToken="csrf"
        canShip={canShip}
        canDeliver={canDeliver}
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
  it('shows reference, status, paid date, item count and total, and the fee notice', () => {
    mountList();
    expect(screen.getByRole('link', { name: /000000A1/ }).getAttribute('href')).toBe(
      '/orders/0190a000-0000-7000-8000-0000000000a1',
    );
    expect(screen.getAllByText('To ship').length).toBeGreaterThan(0);
    expect(screen.getByText('$35.00')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/14 Oct.*10:00 am/)).toBeTruthy();
    expect(screen.getByText(/Delivery fee on every order: \$5\.00/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as shipped' })).toBeNull();
  });

  it('says so when there is no order, with no filter', () => {
    mountList(page([]));
    expect(screen.getByRole('heading', { name: 'No paid orders yet' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Filter orders by fulfilment' })).toBeNull();
  });

  it('filters by fulfilment on the orders loaded', () => {
    mountList(
      page([
        order(),
        order({ sellerOrderId: '0190a000-0000-7000-8000-0000000000a2', fulfilment: 'shipped' }),
        order({ sellerOrderId: '0190a000-0000-7000-8000-0000000000a3', fulfilment: 'delivered' }),
      ]),
    );
    expect(screen.getAllByRole('link', { name: /^#/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Shipped' }));
    expect(screen.getAllByRole('link', { name: /^#/ })).toHaveLength(1);
    expect(screen.getByRole('link', { name: /000000A2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getAllByRole('link', { name: /^#/ })).toHaveLength(3);
  });

  it('shows an empty state for a filter with no match and offers more orders', () => {
    mountList(page([order()], '1.cursor'));
    fireEvent.click(screen.getByRole('button', { name: 'Delivered' }));
    expect(screen.getByRole('heading', { name: 'No orders in this state' })).toBeTruthy();
    expect(screen.getByText(/Show more orders to look further back/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more orders' })).toBeTruthy();
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
    expect(screen.getByText('Aged Basmati Rice')).toBeTruthy();
    expect(screen.getByText('5 kg')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy();
    expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$35.00')).toBeTruthy();
    expect(screen.getByText('Paid 14 Oct 2026, 10:00 am UTC · 2 items')).toBeTruthy();
  });

  it('falls back to a short id for a line whose name could not be read', () => {
    mountDetail(order(), { names: {} });
    expect(screen.getByText('Item 000000D1')).toBeTruthy();
  });

  it('ships with a carrier and an optional tracking reference, then shows the shipment', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: shippedOrder({ carrier: 'Australia Post', trackingRef: 'AP1' }),
    });
    mountDetail();
    fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: ' Australia Post ' } });
    fireEvent.change(screen.getByLabelText(/Tracking reference/), { target: { value: 'AP1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'ordering/seller/orders/0190a000-0000-7000-8000-0000000000a1/ship',
      { carrier: 'Australia Post', trackingRef: 'AP1' },
      'csrf',
    );
    expect(await screen.findByText('Shipped', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Australia Post')).toBeTruthy();
    expect(screen.getByText('AP1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark as delivered' })).toBeTruthy();
    expect(screen.queryByLabelText('Carrier')).toBeNull();
  });

  it('leaves the tracking reference out when it is empty and refuses an empty carrier', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: shippedOrder() });
    mountDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    expect(screen.getByText('Enter the carrier.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: 'Post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({ carrier: 'Post' });
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

  it('shows a conflict in words and keeps the form', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'ordering.fulfilment-conflict' },
    });
    mountDetail();
    fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: 'Post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    expect(await screen.findByText(/already moved on/)).toBeTruthy();
    expect(screen.getByLabelText('Carrier')).toBeTruthy();
  });

  it('hides the actions without the permissions', () => {
    const { unmount } = mountDetail(order(), { canShip: false, canDeliver: false });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('This order has not been shipped yet.')).toBeTruthy();
    unmount();
    mountDetail(shippedOrder(), { canShip: false, canDeliver: false });
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('variantLabelOf', () => {
  const form = {
    taxCategoryCodes: [],
    categories: [],
    fields: [
      {
        code: 'colour',
        dataType: 'select',
        localizable: false,
        required: true,
        isVariantOption: true,
        bounds: {},
        names: { 'en-AU': 'Colour' },
        options: [{ code: 'red', labels: { 'en-AU': 'Red' } }],
      },
    ],
  };
  const withVariants = (variants: unknown) =>
    ({
      published: { content: { variants } },
      workingCopy: null,
      form,
    }) as unknown as Parameters<typeof variantLabelOf>[0];

  it('uses the label the seller gave the variant', () => {
    const product = withVariants([{ variantId: 'v1', labels: { 'en-AU': '1 kg' } }]);
    expect(variantLabelOf(product, 'v1', 'en-AU')).toBe('1 kg');
  });

  it('else joins the labels of its option values, and is null when unknown', () => {
    const product = withVariants([{ variantId: 'v1', optionValues: { colour: 'red' } }]);
    expect(variantLabelOf(product, 'v1', 'en-AU')).toBe('Red');
    expect(variantLabelOf(product, 'other', 'en-AU')).toBeNull();
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
