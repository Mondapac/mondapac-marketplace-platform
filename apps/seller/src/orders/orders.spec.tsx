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
import { SellerOrders } from './seller-orders.tsx';
import type { OwnFee, SellerOrderPage, SellerOrderView } from './types.ts';

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

const mount = (initial = page([order()]), canShip = true, canDeliver = true, flatFee = fee) =>
  render(
    wrap(
      <SellerOrders
        initial={initial}
        fee={flatFee}
        csrfToken="csrf"
        canShip={canShip}
        canDeliver={canDeliver}
      />,
    ),
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SellerOrders', () => {
  it('shows the order, its money, the status and the delivery fee notice', () => {
    mount();
    expect(screen.getByText('To ship')).toBeTruthy();
    expect(screen.getByText('$35.00')).toBeTruthy();
    expect(screen.getAllByText('$5.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/Delivery fee on every order: \$5\.00/)).toBeTruthy();
    expect(screen.getByText('Paid 14 Oct 2026, 10:00 am UTC')).toBeTruthy();
  });

  it('says so when there is no order', () => {
    mount(page([]));
    expect(screen.getByText(/No paid orders yet/)).toBeTruthy();
  });

  it('ships with a carrier and an optional tracking reference, then shows the new state', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: order({
        fulfilment: 'shipped',
        carrier: 'Australia Post',
        trackingRef: 'AP1',
        shippedAt: '2026-10-14T12:00:00.000Z',
      }),
    });
    mount();
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
    expect(await screen.findByText('Shipped')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark as delivered' })).toBeTruthy();
    expect(screen.queryByLabelText('Carrier')).toBeNull();
  });

  it('leaves the tracking reference out when it is empty and refuses an empty carrier', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: order({ fulfilment: 'shipped', carrier: 'Post' }),
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    expect(screen.getByText('Enter the carrier.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: 'Post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({ carrier: 'Post' });
  });

  it('marks a shipped order delivered with an empty body', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: order({
        fulfilment: 'delivered',
        carrier: 'Post',
        shippedAt: '2026-10-14T12:00:00.000Z',
        deliveredAt: '2026-10-15T01:00:00.000Z',
      }),
    });
    mount(
      page([
        order({ fulfilment: 'shipped', carrier: 'Post', shippedAt: '2026-10-14T12:00:00.000Z' }),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mark as delivered' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual([
      'POST',
      'ordering/seller/orders/0190a000-0000-7000-8000-0000000000a1/deliver',
      {},
    ]);
    expect(await screen.findByText('Delivered')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as delivered' })).toBeNull();
  });

  it('shows a conflict in words and keeps the form', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'ordering.fulfilment-conflict' },
    });
    mount();
    fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: 'Post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    expect(await screen.findByText(/already moved on/)).toBeTruthy();
    expect(screen.getByLabelText('Carrier')).toBeTruthy();
  });

  it('hides the actions without the permissions', () => {
    mount(
      page([order(), order({ sellerOrderId: 'x2', fulfilment: 'shipped', carrier: 'Post' })]),
      false,
      false,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('loads the next page by cursor and skips an order it already shows', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: page([order(), order({ sellerOrderId: '0190a000-0000-7000-8000-0000000000a2' })]),
    });
    mount(page([order()], '1.cursor'));
    fireEvent.click(screen.getByRole('button', { name: 'Show more orders' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[1]).toBe('ordering/seller/orders?limit=20&cursor=1.cursor');
    await waitFor(() => expect(screen.getAllByText(/^Order /)).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Show more orders' })).toBeNull();
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
