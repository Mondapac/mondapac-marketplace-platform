import { NextIntlClientProvider } from 'next-intl';
import messages from '../../messages/en.json';
import type { AdminOrderDetail, SellerPart } from './types.ts';

export const money = (amount: string) => ({ amount, currency: 'AUD' });
export const part = (over: Partial<SellerPart> = {}): SellerPart => ({
  sellerOrderId: '0190a000-0000-7000-8000-0000000000b1',
  sellerId: '0190a000-0000-7000-8000-0000000000a1',
  storeName: null,
  subtotal: money('2000'),
  shipping: money('500'),
  discount: money('0'),
  shippingDiscount: money('0'),
  shippingGross: money('500'),
  tax: money('182'),
  total: money('2500'),
  fulfilment: 'to-ship',
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  deliveryMethod: 'scheduled',
  deliveryWindowStart: null,
  deliveryWindowEnd: null,
  readyAt: null,
  deliveryAttention: null,
  lines: [
    {
      lineId: '0190a000-0000-7000-8000-0000000000b1',
      offerId: '0190a000-0000-7000-8000-0000000000c1',
      variantId: '0190a000-0000-7000-8000-0000000000d1',
      quantity: 2,
      unitPrice: money('1000'),
      lineAmount: money('2000'),
      discount: money('0'),
      taxInclusive: true,
      taxRateBps: 1000,
      tax: money('182'),
      productName: null,
      variantLabel: null,
    },
  ],
  ...over,
});
export const order = (over: Partial<AdminOrderDetail> = {}): AdminOrderDetail => ({
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
  refunds: [],
  refundsEnabled: false,
  ...over,
});
/** The page's other props: no refund or note key, no notes loaded. */
export const DETAIL_PROPS = {
  canRefund: false,
  canNote: false,
  notes: [],
  csrfToken: 'csrf',
} as const;
export const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
