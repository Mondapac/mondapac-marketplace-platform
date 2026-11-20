// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { OrderDocumentView, type OrderDocument } from './order-document.tsx';

// The printable order confirmation shows the discounts frozen at placement, in two Markets, and
// no discount row on an order without any.

afterEach(cleanup);

const SELLER = '0190a000-0000-7000-8000-0000000000a1';

function documentOf(currency: string, off: { line: string; goods: string; delivery: string }) {
  const cash = (amount: string) => ({ amount, currency });
  return {
    kind: 'order-confirmation',
    documentNumber: null,
    orderId: '0190a000-0000-7000-8000-000000000001',
    paidAt: '2026-10-13T01:05:00.000Z',
    parts: [
      {
        sellerId: SELLER,
        lines: [
          {
            lineId: '0190a000-0000-7000-8000-0000000000b1',
            variantId: '0190a000-0000-7000-8000-0000000000d1',
            quantity: 2,
            unitPrice: cash('1000'),
            lineAmount: cash('2000'),
            discount: cash(off.line),
            taxInclusive: true,
            tax: cash('155'),
          },
        ],
        subtotal: cash('2000'),
        discount: cash(off.goods),
        shipping: cash('500'),
        shippingDiscount: cash(off.delivery),
        tax: cash('155'),
        total: cash('1700'),
      },
    ],
    total: cash('1700'),
    tax: cash('155'),
  } satisfies OrderDocument;
}

const show = (document: OrderDocument) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
      <OrderDocumentView document={document} parts={[]} />
    </NextIntlClientProvider>,
  );

describe('order document', () => {
  it.each([
    ['AUD', '$'],
    ['NZD', 'NZD '],
  ])('shows the line, goods and delivery discounts (%s)', (currency, sign) => {
    show(documentOf(currency, { line: '300', goods: '300', delivery: '500' }));
    expect(screen.getByText(`Discount −${sign}3.00`)).toBeTruthy();
    expect(screen.getByText(`−${sign}3.00`)).toBeTruthy();
    expect(screen.getByText('Delivery discount')).toBeTruthy();
    expect(screen.getByText(`−${sign}5.00`)).toBeTruthy();
  });

  it('shows no discount row on an order without discounts', () => {
    show(documentOf('AUD', { line: '0', goods: '0', delivery: '0' }));
    expect(screen.queryByText(/Discount/)).toBeNull();
    expect(screen.queryByText(/−/)).toBeNull();
  });
});
