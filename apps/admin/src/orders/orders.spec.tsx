// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { OrderDetail } from './order-detail.tsx';
import { OrdersList } from './orders-list.tsx';
import { FILTERS } from './types.ts';
import type { AdminOrder, AdminOrderPage, SellerPart } from './types.ts';

const call = vi.mocked(callApi);
const money = (amount: string) => ({ amount, currency: 'AUD' });
const part = (over: Partial<SellerPart> = {}): SellerPart => ({
  sellerId: '0190a000-0000-7000-8000-0000000000a1',
  subtotal: money('2000'),
  shipping: money('500'),
  total: money('2500'),
  fulfilment: 'to-ship',
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  lines: [
    {
      lineId: '0190a000-0000-7000-8000-0000000000b1',
      offerId: '0190a000-0000-7000-8000-0000000000c1',
      variantId: '0190a000-0000-7000-8000-0000000000d1',
      quantity: 2,
      unitPrice: money('1000'),
      lineAmount: money('2000'),
      taxInclusive: true,
    },
  ],
  ...over,
});
const order = (over: Partial<AdminOrder> = {}): AdminOrder => ({
  orderId: '0190a000-0000-7000-8000-000000000001',
  status: 'confirmed',
  cancelReason: null,
  paymentState: 'captured',
  total: money('2500'),
  createdAt: '2026-10-13T01:00:00.000Z',
  confirmedAt: '2026-10-13T01:05:00.000Z',
  cancelledAt: null,
  payBy: null,
  sellerOrders: [part()],
  accountId: '0190a000-0000-7000-8000-0000000000e1',
  paymentIntentId: 'pi_123',
  ...over,
});
const page = (orders: AdminOrder[], nextCursor: string | null = null) => ({
  ok: true as const,
  status: 200,
  body: { orders, nextCursor } satisfies AdminOrderPage,
});
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('orders list', () => {
  it('lists the orders with reference, status, sellers and total', async () => {
    call.mockResolvedValueOnce(
      page([
        order(),
        order({
          orderId: '0190a000-0000-7000-8000-000000000002',
          status: 'pending-payment',
          confirmedAt: null,
          sellerOrders: [part(), part({ sellerId: '0190a000-0000-7000-8000-0000000000a2' })],
          total: money('5000'),
        }),
      ]),
    );
    render(wrap(<OrdersList />));
    const table = await screen.findByRole('table');
    const link = within(table).getByRole('link', { name: 'Order 00000001' });
    expect(link.getAttribute('href')).toBe('/orders/0190a000-0000-7000-8000-000000000001');
    expect(within(table).getByText('Paid')).toBeTruthy();
    expect(within(table).getByText('Awaiting payment')).toBeTruthy();
    expect(within(table).getByText('$25.00')).toBeTruthy();
    expect(within(table).getByText('$50.00')).toBeTruthy();
    expect(within(table).getAllByText('000000E1')).toHaveLength(2);
    expect(call).toHaveBeenCalledWith('GET', 'ordering/admin/orders');
  });

  it('filters by status and asks again', async () => {
    call.mockResolvedValue(page([order()]));
    render(wrap(<OrdersList />));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith('GET', 'ordering/admin/orders?status=cancelled'),
    );
  });

  it('pages by cursor with Show more', async () => {
    call.mockResolvedValueOnce(page([order()], 'next-1'));
    render(wrap(<OrdersList />));
    await screen.findByRole('table');
    call.mockResolvedValueOnce(page([order({ orderId: '0190a000-0000-7000-8000-000000000003' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('link', { name: 'Order 00000003' })).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('GET', 'ordering/admin/orders?cursor=next-1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows an empty state', async () => {
    call.mockResolvedValueOnce(page([]));
    render(wrap(<OrdersList />));
    expect(await screen.findByText(/No orders yet/)).toBeTruthy();
  });

  it('says which status is empty on a filtered tab', async () => {
    call.mockResolvedValue(page([]));
    render(wrap(<OrdersList />));
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
    expect(await screen.findByText('No cancelled orders')).toBeTruthy();
    expect(screen.getByText(/expired or failed/)).toBeTruthy();
  });

  it('shows the error with a retry that loads again', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    render(wrap(<OrdersList />));
    expect(await screen.findByText(/couldn't load the orders/)).toBeTruthy();
    call.mockResolvedValueOnce(page([order()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('offers exactly the statuses the admin API accepts', async () => {
    expect(FILTERS).toEqual(['all', 'pending-payment', 'confirmed', 'cancelled']);
    call.mockResolvedValueOnce(page([]));
    render(wrap(<OrdersList />));
    const tabs = within(screen.getByRole('navigation')).getAllByRole('button');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'All',
      'Awaiting payment',
      'Paid',
      'Cancelled',
    ]);
    await screen.findByText(/No orders yet/);
  });
});

describe('order detail', () => {
  it('shows the summary, the seller part, its lines and totals', () => {
    render(wrap(<OrderDetail order={order()} />));
    expect(screen.getByRole('heading', { name: 'Order 00000001' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to orders' }).getAttribute('href')).toBe(
      '/orders',
    );
    expect(screen.getByText('Captured')).toBeTruthy();
    expect(screen.getByText('pi_123')).toBeTruthy();
    expect(screen.getByText('Variant 000000D1')).toBeTruthy();
    expect(screen.getByText(/2 x \$10\.00/)).toBeTruthy();
    expect(screen.getByText(/Tax included/)).toBeTruthy();
    expect(screen.getByText('To ship')).toBeTruthy();
    expect(screen.getByText('$5.00')).toBeTruthy();
  });

  it('shows carrier, tracking and times once shipped, and the cancel reason when cancelled', () => {
    render(
      wrap(
        <OrderDetail
          order={order({
            status: 'cancelled',
            cancelReason: 'payment-failed',
            cancelledAt: '2026-10-13T02:00:00.000Z',
            paymentState: 'voided',
            sellerOrders: [
              part({
                fulfilment: 'delivered',
                carrier: 'Australia Post',
                trackingRef: 'AP123',
                shippedAt: '2026-10-14T01:00:00.000Z',
                deliveredAt: '2026-10-15T01:00:00.000Z',
              }),
            ],
          })}
        />,
      ),
    );
    expect(screen.getByText('Payment failed')).toBeTruthy();
    expect(screen.getByText('Australia Post')).toBeTruthy();
    expect(screen.getByText('AP123')).toBeTruthy();
    expect(screen.getAllByText('Delivered')).toHaveLength(2);
    expect(screen.getByText('Voided')).toBeTruthy();
  });
});

describe('orders nav', () => {
  it('shows the entry only with the view key', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('orders');
    expect(ids(['ordering.order.view'])).toContain('orders');
  });
});
