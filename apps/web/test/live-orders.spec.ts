import { describe, expect, it } from 'vitest';
import {
  accountOrderOf,
  accountOrdersOf,
  isOrderId,
  orderReference,
  shipToLine,
} from '../src/account/live-orders.ts';

// The buyer's real orders as the account pages show them, for two Markets (AUD and a synthetic
// zero-decimal currency): only paid orders, each field checked on its own.

const ORDER = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VARIANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
const SELLER_B = '16fd2706-8baf-433b-82eb-8c7fada847da';
const LABELS = { unnamedItem: 'Item no longer listed', unnamedSeller: 'Seller' };

const money = (amount: string, currency: string) => ({ amount, currency });

function orderBody(currency: string, extra: object = {}) {
  const line = (productName: string | null, variantLabel: string | null) => ({
    offerId: OFFER,
    variantId: VARIANT,
    quantity: 2,
    unitPrice: money('1250', currency),
    productName,
    variantLabel,
  });
  return {
    orderId: ORDER,
    status: 'confirmed',
    confirmedAt: '2026-10-20T23:30:00.000Z',
    tax: money('341', currency),
    sellerNotes: { [SELLER]: 'Ring twice' },
    sellerOrders: [
      {
        sellerId: SELLER,
        storeName: 'Halal Corner',
        fulfilment: 'delivered',
        deliveredAt: '2026-10-22T02:00:00.000Z',
        deliveryMethod: 'instant',
        shipping: money('750', currency),
        lines: [line('Lamb mince', '500 g')],
      },
      {
        sellerId: SELLER_B,
        storeName: null,
        fulfilment: 'to-ship',
        deliveredAt: null,
        deliveryMethod: 'pickup',
        shipping: money('0', currency),
        lines: [line(null, null)],
      },
    ],
    ...extra,
  };
}

describe.each(['AUD', 'JPY'])('a paid order in %s', (currency) => {
  it('becomes the account order with its parts, names, notes and tax', () => {
    const order = accountOrderOf(orderBody(currency), LABELS, 'Jo Smith: 1 Main St, Kedron 4031');
    expect(order).toEqual({
      id: ORDER.toLowerCase(),
      reference: '3F2504E0',
      placedOn: '2026-10-20',
      status: 'in-progress',
      deliveredTo: 'Jo Smith: 1 Main St, Kedron 4031',
      includedTax: { amount: 341, currency },
      parts: [
        {
          sellerId: SELLER,
          sellerName: 'Halal Corner',
          status: 'delivered',
          deliveryMethod: 'instant',
          deliveredOn: '2026-10-22',
          deliveryFee: { amount: 750, currency },
          note: 'Ring twice',
          lines: [
            {
              offerId: `${OFFER}:${VARIANT}`,
              name: 'Lamb mince, 500 g',
              category: '',
              quantity: 2,
              unitPrice: { amount: 1250, currency },
            },
          ],
        },
        {
          sellerId: SELLER_B,
          sellerName: 'Seller',
          status: 'confirmed',
          deliveryMethod: 'pickup',
          deliveryFee: { amount: 0, currency },
          lines: [expect.objectContaining({ name: 'Item no longer listed' })],
        },
      ],
    });
  });

  it('is delivered when every part is, and cancelled parts follow a cancelled order', () => {
    const delivered = orderBody(currency);
    delivered.sellerOrders[1] = { ...delivered.sellerOrders[0]!, sellerId: SELLER_B };
    expect(accountOrderOf(delivered, LABELS)?.status).toBe('delivered');
    const cancelled = accountOrderOf(orderBody(currency, { status: 'cancelled' }), LABELS);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.parts.map((part) => part.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('has no GST line without a tax record', () => {
    const order = accountOrderOf(orderBody(currency, { tax: null }), LABELS);
    expect(order?.taxKnown).toBe(false);
    expect(order?.includedTax).toEqual({ amount: 0, currency });
  });
});

describe('orders that are not shown', () => {
  it('leaves out unpaid orders and bodies it cannot read', () => {
    const body = orderBody('AUD');
    expect(accountOrderOf({ ...body, status: 'pending-payment' }, LABELS)).toBeNull();
    expect(accountOrderOf({ ...body, confirmedAt: null }, LABELS)).toBeNull();
    expect(accountOrderOf({ ...body, orderId: 'MP-1' }, LABELS)).toBeNull();
    expect(accountOrderOf({ ...body, sellerOrders: [] }, LABELS)).toBeNull();
    const badLine = orderBody('AUD');
    badLine.sellerOrders[0]!.lines[0]!.quantity = 0;
    expect(accountOrderOf(badLine, LABELS)).toBeNull();
    const badMoney = orderBody('AUD');
    badMoney.sellerOrders[0]!.shipping = money('-1', 'AUD');
    expect(accountOrderOf(badMoney, LABELS)).toBeNull();
    expect(accountOrderOf('junk', LABELS)).toBeNull();
  });

  it('keeps the readable orders of a page and refuses a body that is not a page', () => {
    const page = { orders: [orderBody('AUD'), { orderId: 'junk' }], nextCursor: null };
    expect(accountOrdersOf(page, LABELS)?.map((o) => o.reference)).toEqual(['3F2504E0']);
    expect(accountOrdersOf({ items: [] }, LABELS)).toBeNull();
  });
});

describe('ids and addresses', () => {
  it('checks order ids and gives the short reference', () => {
    expect(isOrderId(ORDER)).toBe(true);
    expect(isOrderId('MP-20481')).toBe(false);
    expect(orderReference(ORDER.toLowerCase())).toBe('3F2504E0');
  });

  it('writes the delivery address as one line, empty when it is missing or incomplete', () => {
    const shipTo = {
      recipientFirstName: 'Jo',
      recipientLastName: 'Smith',
      line1: '1 Main St',
      line2: 'Unit 2',
      suburb: 'Kedron',
      region: 'QLD',
      postcode: '4031',
    };
    expect(shipToLine({ shipTo })).toBe('Jo Smith: 1 Main St, Unit 2, Kedron QLD 4031');
    expect(shipToLine({ shipTo: { ...shipTo, line2: null, region: null } })).toBe(
      'Jo Smith: 1 Main St, Kedron 4031',
    );
    expect(shipToLine({ shipTo: { ...shipTo, suburb: '' } })).toBe('');
    expect(shipToLine({ shipTo: null })).toBe('');
  });
});
