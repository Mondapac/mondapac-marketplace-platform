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
  storeName: null,
  subtotal: money('2000'),
  shipping: money('500'),
  tax: money('182'),
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
      taxRateBps: 1000,
      tax: money('182'),
      productName: null,
      variantLabel: null,
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
  tax: money('182'),
  createdAt: '2026-10-13T01:00:00.000Z',
  confirmedAt: '2026-10-13T01:05:00.000Z',
  cancelledAt: null,
  payBy: null,
  sellerOrders: [part()],
  accountId: '0190a000-0000-7000-8000-0000000000e1',
  customer: null,
  paymentIntentId: 'pi_123',
  taxStrategyId: null,
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
    expect(within(table).getAllByText('000000A1')).toHaveLength(2);
    expect(call).toHaveBeenCalledWith('GET', 'ordering/admin/orders');
  });

  it('shows customer name with email, and shop names, when the API sends them', async () => {
    const named = part({ storeName: 'Al Noor Butchery' });
    call.mockResolvedValueOnce(
      page([
        order({
          customer: { displayName: 'Amira Haddad', email: 'amira@example.com' },
          sellerOrders: [
            named,
            part({ sellerId: '0190a000-0000-7000-8000-0000000000a2', storeName: null }),
          ],
        }),
        order({
          orderId: '0190a000-0000-7000-8000-000000000002',
          customer: { displayName: null, email: 'noname@example.com' },
        }),
      ]),
    );
    render(wrap(<OrdersList />));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Amira Haddad')).toBeTruthy();
    expect(within(table).getByText('amira@example.com')).toBeTruthy();
    expect(within(table).getByText('noname@example.com')).toBeTruthy();
    expect(within(table).getByText('Al Noor Butchery')).toBeTruthy();
    expect(within(table).getByText('000000A2')).toBeTruthy();
    expect(within(table).queryByText('000000E1')).toBeNull();
  });

  it('falls back to the short id without the customer fields', async () => {
    call.mockResolvedValueOnce(page([order()]));
    render(wrap(<OrdersList />));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('000000E1')).toBeTruthy();
    expect(within(table).getByText('000000A1')).toBeTruthy();
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

  it('pages by cursor with Previous and Next, and walks back to the page it came from', async () => {
    call.mockResolvedValueOnce(page([order()], 'next-1'));
    render(wrap(<OrdersList />));
    await screen.findByRole('table');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(true);
    call.mockResolvedValueOnce(page([order({ orderId: '0190a000-0000-7000-8000-000000000003' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('link', { name: 'Order 00000003' })).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('GET', 'ordering/admin/orders?cursor=next-1');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    call.mockResolvedValueOnce(page([order()], 'next-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('link', { name: 'Order 00000001' })).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('GET', 'ordering/admin/orders');
    // Previous and next has no sort: the order is newest first.
    expect(screen.queryByLabelText('Sort by')).toBeNull();
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

const pageOf = (orders: AdminOrder[], total: number, number = 1) => ({
  ok: true as const,
  status: 200,
  body: {
    orders,
    nextCursor: null,
    total,
    page: number,
    pageSize: 25,
  } satisfies AdminOrderPage,
});

describe('orders list in page-number mode', () => {
  it('asks for a page with its sort and shows the range of the total', async () => {
    call.mockResolvedValue(pageOf([order()], 60));
    render(wrap(<OrdersList paging="pages" />));
    await screen.findByRole('table');
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'ordering/admin/orders?page=1&pageSize=25&sort=created&direction=desc',
    );
    expect(screen.getByText('1 to 1 of 60')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 3' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Page 4' })).toBeNull();
  });

  it('goes to the page that is clicked and back to the first after a filter changes', async () => {
    call.mockResolvedValue(pageOf([order()], 60));
    render(wrap(<OrdersList paging="pages" />));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'GET',
        'ordering/admin/orders?page=2&pageSize=25&sort=created&direction=desc',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'GET',
        'ordering/admin/orders?status=cancelled&page=1&pageSize=25&sort=created&direction=desc',
      ),
    );
  });

  it('sorts by total and filters by payment, delivery and day (the last day is included)', async () => {
    call.mockResolvedValue(pageOf([order()], 1));
    render(wrap(<OrdersList paging="pages" />));
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'total-high' } });
    fireEvent.change(screen.getByLabelText('Payment'), { target: { value: 'captured' } });
    fireEvent.change(screen.getByLabelText('Delivery'), { target: { value: 'shipped' } });
    fireEvent.change(screen.getByLabelText('Placed from (UTC)'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(screen.getByLabelText('Placed until (UTC)'), {
      target: { value: '2026-10-31' },
    });
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'GET',
        'ordering/admin/orders?paymentState=captured&fulfilment=shipped' +
          '&from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z' +
          '&page=1&pageSize=25&sort=total&direction=desc',
      ),
    );
    call.mockResolvedValue(pageOf([], 0));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No orders yet')).toBeTruthy();
  });

  it('does not ask when the end day is before the start day, and says so', async () => {
    call.mockResolvedValue(pageOf([order()], 1));
    render(wrap(<OrdersList paging="pages" />));
    await screen.findByRole('table');
    call.mockClear();
    fireEvent.change(screen.getByLabelText('Placed from (UTC)'), {
      target: { value: '2026-10-10' },
    });
    fireEvent.change(screen.getByLabelText('Placed until (UTC)'), {
      target: { value: '2026-10-01' },
    });
    expect(await screen.findByText('The end day is before the start day.')).toBeTruthy();
    expect(screen.getByText('No orders match')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('stops page numbers at the API limit and tells the admin how to go further', async () => {
    call.mockResolvedValue(pageOf([order()], 12_345));
    render(wrap(<OrdersList paging="pages" />));
    await screen.findByRole('table');
    expect(screen.getByText(/Page numbers stop at the first 10,000 orders/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 400' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Page 401' })).toBeNull();
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
    expect(screen.getByText('000000C1').getAttribute('title')).toContain('0000000000c1');
    expect(screen.getByText(/Offer 000000C1/)).toBeTruthy();
    expect(screen.getByText(/Variant 000000D1/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Seller 000000A1' })).toBeTruthy();
    expect(screen.queryByText('Customer email')).toBeNull();
    expect(screen.getByText(/2 x \$10\.00/)).toBeTruthy();
    expect(screen.getByText(/Tax included/)).toBeTruthy();
    expect(screen.getByText('To ship')).toBeTruthy();
    expect(screen.getByText('$5.00')).toBeTruthy();
  });

  it('shows names for the customer, the shop and each line when present', () => {
    render(
      wrap(
        <OrderDetail
          order={order({
            customer: { displayName: 'Amira Haddad', email: 'amira@example.com' },
            sellerOrders: [
              part({
                storeName: 'Al Noor Butchery',
                lines: [
                  {
                    ...part().lines[0]!,
                    productName: 'Lamb shoulder',
                    variantLabel: '1 kg',
                  },
                ],
              }),
            ],
          })}
        />,
      ),
    );
    expect(screen.getByText('Amira Haddad')).toBeTruthy();
    expect(screen.getByText('amira@example.com')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Al Noor Butchery' })).toBeTruthy();
    expect(screen.getByText('Lamb shoulder · 1 kg')).toBeTruthy();
    expect(screen.getByText('0190a000-0000-7000-8000-0000000000a1')).toBeTruthy();
    expect(screen.getByText('0190a000-0000-7000-8000-0000000000e1')).toBeTruthy();
  });

  it('shows a null customer name as not set, and a null variant label as the product only', () => {
    render(
      wrap(
        <OrderDetail
          order={order({
            customer: { displayName: null, email: 'a@example.com' },
            sellerOrders: [
              part({
                lines: [{ ...part().lines[0]!, productName: 'Dates', variantLabel: null }],
              }),
            ],
          })}
        />,
      ),
    );
    expect(screen.getByText('Dates')).toBeTruthy();
    expect(screen.getByText('Customer name').nextElementSibling?.textContent).toBe('Not set');
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

describe('order tax', () => {
  it('shows the tax of the order, of each seller and of each line, and the strategy', () => {
    render(wrap(<OrderDetail order={order()} />));
    expect(screen.getByText('Tax')).toBeTruthy();
    expect(screen.getByText('Market default')).toBeTruthy();
    expect(screen.getByText('Tax in prices')).toBeTruthy();
    expect(screen.getAllByText('$1.82')).toHaveLength(2);
    expect(screen.getByText(/Tax 10%: \$1\.82/)).toBeTruthy();
  });

  it('names a stored strategy by id and labels tax added on top of the prices', () => {
    const exclusive = part({
      lines: part().lines.map((line) => ({ ...line, taxInclusive: false, tax: money('200') })),
      tax: money('200'),
    });
    render(
      wrap(
        <OrderDetail
          order={order({
            tax: money('200'),
            taxStrategyId: '0190a000-0000-7000-8000-0000000000f1',
            sellerOrders: [exclusive],
          })}
        />,
      ),
    );
    expect(screen.queryByText('Market default')).toBeNull();
    expect(screen.getByText('0190a000-0000-7000-8000-0000000000f1')).toBeTruthy();
    expect(screen.getByText('Tax added')).toBeTruthy();
    expect(screen.queryByText(/Tax included/)).toBeNull();
  });

  it('says the tax was not recorded on an older order, never zero', () => {
    const old = part({
      lines: part().lines.map((line) => ({ ...line, taxRateBps: null, tax: null })),
      tax: null,
    });
    render(wrap(<OrderDetail order={order({ tax: null, sellerOrders: [old] })} />));
    expect(screen.getAllByText('Not recorded')).toHaveLength(2);
    expect(screen.queryByText('Market default')).toBeNull();
    expect(screen.queryByText(/Tax 10%/)).toBeNull();
  });
});

describe('orders nav', () => {
  it('shows the entry only with the view key', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('orders');
    expect(ids(['ordering.order.view'])).toContain('orders');
  });
});
