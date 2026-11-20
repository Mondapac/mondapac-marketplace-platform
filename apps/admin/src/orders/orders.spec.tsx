// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminNav } from '../nav.ts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { OrderDetail } from './order-detail.tsx';
import { money, order, part, DETAIL_PROPS, wrap } from './orders-test-kit.tsx';

afterEach(cleanup);

describe('order detail', () => {
  it('lists the refunds with their state and reason, and a refused one as not refunded', () => {
    const refund = {
      refundId: '0190a000-0000-7000-8000-0000000000f1',
      sellerOrderId: '0190a000-0000-7000-8000-0000000000b1',
      reason: 'damaged',
      lossBearer: 'seller',
      lossReasonCode: null,
      amount: money('1000'),
      tax: money('91'),
      shipping: null,
      lines: [
        {
          orderLineId: '0190a000-0000-7000-8000-0000000000b1',
          quantity: 1,
          amount: money('1000'),
          tax: money('91'),
        },
      ],
      requestedAt: '2026-10-14T01:00:00.000Z',
      settledAt: null,
      creditNoteId: null,
    };
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({
            refundsEnabled: true,
            refunds: [
              { ...refund, state: 'failed' },
              {
                ...refund,
                refundId: '0190a000-0000-7000-8000-0000000000f2',
                state: 'pending',
                reason: 'item-unavailable',
              },
            ],
          })}
        />,
      ),
    );
    expect(screen.getByText('Refused by Stripe')).toBeTruthy();
    expect(screen.getByText('Waiting for Stripe')).toBeTruthy();
    expect(screen.getByText(/Not refunded/)).toBeTruthy();
    // The seller's own reason (row 40) has its own label, not "Other".
    expect(screen.getByText(/^Item unavailable ·/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Order confirmation' }).getAttribute('href')).toBe(
      '/orders/0190a000-0000-7000-8000-000000000001/document',
    );
  });

  it('shows the summary, the seller part, its lines and totals', () => {
    render(wrap(<OrderDetail {...DETAIL_PROPS} canViewCustomer={false} order={order()} />));
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
          {...DETAIL_PROPS}
          canViewCustomer={false}
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
          {...DETAIL_PROPS}
          canViewCustomer={false}
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
          {...DETAIL_PROPS}
          canViewCustomer={false}
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
    expect(screen.getByText(/This order was cancelled: Payment failed\./)).toBeTruthy();
    expect(screen.getByText('Australia Post')).toBeTruthy();
    expect(screen.getByText('AP123')).toBeTruthy();
    expect(screen.getAllByText('Delivered')).toHaveLength(1);
    expect(screen.getByText('Voided')).toBeTruthy();
  });
});

describe('order detail layout', () => {
  it('shows the fulfilment steps, the delivery method and the activity from recorded times', () => {
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({
            sellerOrders: [
              part({
                storeName: 'Al Noor Butchery',
                fulfilment: 'shipped',
                deliveryMethod: 'same_day',
                readyAt: '2026-10-13T02:00:00.000Z',
                shippedAt: '2026-10-13T03:00:00.000Z',
              }),
            ],
          })}
        />,
      ),
    );
    const steps = screen.getByRole('list', { name: 'Progress' });
    expect(within(steps).getByText('Waiting')).toBeTruthy();
    expect(within(steps).getAllByText(/2026/)).toHaveLength(2);
    expect(screen.getByText('Same-day delivery')).toBeTruthy();
    const activity = screen.getByRole('heading', { name: 'Activity' }).parentElement!;
    const items = within(activity).getAllByRole('listitem');
    expect(items.map((item) => item.firstElementChild?.textContent)).toEqual([
      'Order placed',
      'Payment confirmed',
      'Al Noor Butchery marked ready',
      'Al Noor Butchery shipped',
    ]);
  });

  it('shows a delivery problem the platform must look at', () => {
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({ sellerOrders: [part({ deliveryAttention: 'carrier-unknown' })] })}
        />,
      ),
    );
    expect(screen.getByText(/Delivery needs a look/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives a pickup part its own steps and activity wording, with no shipping', () => {
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({
            sellerOrders: [
              part({
                storeName: 'Al Noor Butchery',
                fulfilment: 'delivered',
                deliveryMethod: 'pickup',
                readyAt: '2026-10-13T02:00:00.000Z',
                deliveredAt: '2026-10-13T03:00:00.000Z',
              }),
            ],
          })}
        />,
      ),
    );
    const steps = screen.getByRole('list', { name: 'Progress' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.firstElementChild?.textContent),
    ).toEqual(['Ready for pickup', 'Collected']);
    expect(within(steps).queryByText('Shipped')).toBeNull();
    expect(screen.getByText('Al Noor Butchery handed over for pickup')).toBeTruthy();
    expect(screen.getByText('Al Noor Butchery marked ready for pickup')).toBeTruthy();
  });

  it('shows no steps before payment or after a cancel', () => {
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({ status: 'cancelled', cancelReason: 'expired', confirmedAt: null })}
        />,
      ),
    );
    expect(screen.queryByRole('list', { name: 'Progress' })).toBeNull();
  });

  it('shows the customer window with an en dash, and Done for a step with no time', () => {
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({
            sellerOrders: [
              part({
                fulfilment: 'delivered',
                deliveryWindowStart: '2026-10-13T05:00:00.000Z',
                deliveryWindowEnd: '2026-10-13T07:00:00.000Z',
              }),
            ],
          })}
        />,
      ),
    );
    expect(screen.getByText(/ \u2013 /)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Progress' })).getAllByText('Done'),
    ).toHaveLength(3);
  });

  it('shows Not recorded for an unknown delivery method', () => {
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({ sellerOrders: [part({ deliveryMethod: 'drone' })] })}
        />,
      ),
    );
    expect(screen.getByText('Not recorded')).toBeTruthy();
  });

  it('tells a failed customer lookup from hidden details', () => {
    const { unmount } = render(
      wrap(<OrderDetail {...DETAIL_PROPS} canViewCustomer={true} order={order()} />),
    );
    expect(screen.getByText(/couldn't be loaded/)).toBeTruthy();
    expect(screen.queryByText(/hidden for your role/)).toBeNull();
    unmount();
    render(wrap(<OrderDetail {...DETAIL_PROPS} canViewCustomer={false} order={order()} />));
    expect(screen.getByText(/hidden for your role/)).toBeTruthy();
    expect(screen.queryByText(/couldn't be loaded/)).toBeNull();
  });

  it('says so when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
      configurable: true,
    });
    render(wrap(<OrderDetail {...DETAIL_PROPS} canViewCustomer={false} order={order()} />));
    fireEvent.click(screen.getByRole('button', { name: 'Copy order ID' }));
    await waitFor(() => expect(screen.getByText(/Couldn't copy/)).toBeTruthy());
  });

  it('says when the customer details are hidden, and copies the order id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(wrap(<OrderDetail {...DETAIL_PROPS} canViewCustomer={false} order={order()} />));
    expect(screen.getByText(/hidden for your role/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy order ID' }));
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('0190a000-0000-7000-8000-000000000001');
  });
});

describe('order tax', () => {
  it('shows the tax of the order, of each seller and of each line, and the strategy', () => {
    render(wrap(<OrderDetail {...DETAIL_PROPS} canViewCustomer={false} order={order()} />));
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
          {...DETAIL_PROPS}
          canViewCustomer={false}
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
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({ tax: null, sellerOrders: [old] })}
        />,
      ),
    );
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

describe('order discounts (promotions T2)', () => {
  it.each([
    ['AUD', '$'],
    ['NZD', 'NZD '],
  ])(
    'shows the discounts of a line and a seller part only when there are any (%s)',
    (currency, sign) => {
      const cash = (amount: string) => ({ amount, currency });
      const discounted = part({
        subtotal: cash('2000'),
        shipping: cash('500'),
        shippingGross: cash('0'),
        discount: cash('300'),
        shippingDiscount: cash('500'),
        tax: cash('155'),
        total: cash('1700'),
        lines: part().lines.map((line) => ({
          ...line,
          unitPrice: cash('1000'),
          lineAmount: cash('2000'),
          discount: cash('300'),
          tax: cash('155'),
        })),
      });
      render(
        wrap(
          <OrderDetail
            {...DETAIL_PROPS}
            canViewCustomer={false}
            order={order({ total: cash('1700'), tax: cash('155'), sellerOrders: [discounted] })}
          />,
        ),
      );
      expect(screen.getByText((text) => text.includes(`Discount: ${sign}3.00`))).toBeTruthy();
      expect(screen.getByText('Discount')).toBeTruthy();
      expect(screen.getByText(`−${sign}3.00`)).toBeTruthy();
      expect(screen.getByText('Delivery discount')).toBeTruthy();
      expect(screen.getByText(`−${sign}5.00`)).toBeTruthy();
      cleanup();
      render(wrap(<OrderDetail {...DETAIL_PROPS} canViewCustomer={false} order={order()} />));
      expect(screen.queryByText(/Discount/)).toBeNull();
      expect(screen.queryByText('Delivery discount')).toBeNull();
    },
  );

  it('names the discount-changed cancel reason', () => {
    render(
      wrap(
        <OrderDetail
          {...DETAIL_PROPS}
          canViewCustomer={false}
          order={order({
            status: 'cancelled',
            cancelReason: 'discount-changed',
            cancelledAt: '2026-10-13T02:00:00.000Z',
            confirmedAt: null,
            paymentState: 'none',
          })}
        />,
      ),
    );
    expect(
      screen.getByText(/This order was cancelled: A discount no longer applied\./),
    ).toBeTruthy();
  });
});
