// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { Earnings } from '../earnings/earnings.tsx';
import type { Ledger } from '../earnings/types.ts';
import { OrderDetail } from '../orders/order-detail.tsx';
import type { SellerOrderView } from '../orders/types.ts';
import { DisputeNotice } from './dispute-notice.tsx';
import { DisputedOrders } from './disputed-orders.tsx';
import type { OwnDispute } from './types.ts';

const SELLER_ORDER = '0190a000-0000-7000-8000-0000000000a1';
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const dispute = (over: Partial<OwnDispute> = {}): OwnDispute => ({
  sellerOrderId: SELLER_ORDER,
  orderId: '0190a000-0000-7000-8000-0000000000b9',
  since: '2026-10-20T01:00:00.000Z',
  open: true,
  recoveredAmount: null,
  ...over,
});
const aud = (amount: string) => ({ amount, currency: 'AUD' });
const sellerOrder: SellerOrderView = {
  sellerOrderId: SELLER_ORDER,
  orderId: '0190a000-0000-7000-8000-0000000000b9',
  paidAt: '2026-10-14T10:00:00.000Z',
  subtotal: aud('3000'),
  shipping: aud('500'),
  total: aud('3500'),
  fulfilment: 'to-ship',
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  deliveryMethod: 'same_day',
  deliveryWindowStart: null,
  deliveryWindowEnd: null,
  readyAt: null,
  deliveryAttention: null,
  pickup: null,
  lines: [],
} as unknown as SellerOrderView;
const ledger: Ledger = {
  sellerId: 's',
  currency: 'AUD',
  totals: {
    sales: '3000',
    shipping: '500',
    commission: '450',
    refundedSales: '0',
    refundedShipping: '0',
    refundedCommission: '0',
    disputeDebits: '4000',
    disputeReinstated: '0',
    balance: '-950',
  },
  entries: [
    {
      entryId: '0190a000-0000-7000-8000-00000000e001',
      orderId: '0190a000-0000-7000-8000-00000000b001',
      kind: 'dispute-debit',
      direction: 'debit',
      amount: '4000',
      occurredAt: '2026-10-22T10:00:00.000Z',
    },
    {
      entryId: '0190a000-0000-7000-8000-00000000e002',
      orderId: '0190a000-0000-7000-8000-00000000b002',
      kind: 'dispute-reinstate',
      direction: 'credit',
      amount: '1000',
      occurredAt: '2026-10-23T10:00:00.000Z',
    },
  ],
  nextCursor: null,
};

afterEach(cleanup);

describe('dispute notice', () => {
  it('says the payment is disputed and held, once, in a critical banner', () => {
    render(wrap(<DisputeNotice dispute={dispute()} />));
    expect(screen.getAllByText('Payment disputed')).toHaveLength(1);
    expect(screen.getByRole('alert').className).toContain('critical');
    expect(screen.getByText('Held until the dispute is closed.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says what was taken once the dispute closed with a recovery', () => {
    render(
      wrap(
        <DisputeNotice
          dispute={dispute({
            open: false,
            recoveredAmount: { amountMinor: '4000', currency: 'AUD' },
          })}
        />,
      ),
    );
    expect(screen.getByText('Dispute closed. $40.00 was taken from your earnings.')).toBeTruthy();
    expect(screen.queryByText('Payment disputed')).toBeNull();
  });

  it('shows nothing for a closed dispute that took nothing, or for no dispute', () => {
    const { container, rerender } = render(
      wrap(<DisputeNotice dispute={dispute({ open: false })} />),
    );
    expect(container.textContent).toBe('');
    rerender(wrap(<DisputeNotice dispute={null} />));
    expect(container.textContent).toBe('');
  });

  it('never renders a reason, evidence date, provider id or buyer data, even if the answer carried them', () => {
    const leaky = {
      ...dispute(),
      reason: 'fraudulent',
      evidenceDueBy: '2026-10-29T10:00:00.000Z',
      providerDisputeId: 'dp_SECRET',
      buyerEmail: 'buyer@example.com',
      cardLast4: '4242',
    } as OwnDispute;
    const { container } = render(
      wrap(
        <>
          <DisputeNotice dispute={leaky} />
          <DisputedOrders disputes={[leaky]} />
        </>,
      ),
    );
    const text = container.textContent ?? '';
    for (const secret of ['fraudulent', 'dp_SECRET', 'buyer@example.com', '4242', '29 Oct']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/reason|evidence|deadline|chargeback|stripe|bank/i);
    expect(container.querySelector('a[href^="http"]')).toBeNull();
  });
});

describe('disputed orders card', () => {
  it('lists only the open ones, each linking to its order', () => {
    render(
      wrap(
        <DisputedOrders
          disputes={[
            dispute(),
            dispute({
              sellerOrderId: '0190a000-0000-7000-8000-0000000000a2',
              open: false,
              recoveredAmount: { amountMinor: '100', currency: 'AUD' },
            }),
          ]}
        />,
      ),
    );
    const card = screen
      .getByRole('heading', { name: 'Disputed orders' })
      .closest('section') as HTMLElement;
    const link = within(card).getByRole('link', { name: 'Order 000000A1' });
    expect(link.getAttribute('href')).toBe(`/orders/${SELLER_ORDER}`);
    expect(within(card).getAllByRole('link')).toHaveLength(1);
    expect(within(card).getByText('Payment disputed')).toBeTruthy();
  });

  it('is absent when no dispute is open', () => {
    const { container } = render(wrap(<DisputedOrders disputes={[dispute({ open: false })]} />));
    expect(container.textContent).toBe('');
  });
});

describe('where the notice appears', () => {
  it('shows a banner near the top of the order page', () => {
    render(
      wrap(
        <OrderDetail
          initial={sellerOrder}
          csrfToken="c"
          canMarkReady={false}
          canDeliver={false}
          dispute={dispute()}
        />,
      ),
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Payment disputed')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the card on Earnings and names the dispute ledger kinds plainly', () => {
    render(wrap(<Earnings initial={ledger} disputes={[dispute()]} />));
    expect(screen.getByRole('heading', { name: 'Disputed orders' })).toBeTruthy();
    expect(screen.getByText('Dispute: amount recovered')).toBeTruthy();
    expect(screen.getByText('Dispute: amount returned')).toBeTruthy();
  });

  it('keeps Earnings as it was without disputes', () => {
    render(wrap(<Earnings initial={ledger} />));
    expect(screen.queryByText('Disputed orders')).toBeNull();
  });
});
