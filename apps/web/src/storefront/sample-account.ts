import 'server-only';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from './sample-cart.ts';
import type {
  AccountOrder,
  AccountSource,
  Money,
  OrderLine,
  OrderPart,
  PickupCode,
} from './types.ts';

// Sample data of the buyer account pages (approved design, account-a-teal v7). It stands in for
// the account backend (orders read, profile, password, saved lists), which is not built yet
// (handoffs/account.md); only this file goes when the pages are wired. Every value is a sample.

const money = (amount: number): Money => ({ amount, currency: 'AUD' });

/** What each sample seller's part paid for delivery, GST included (sample values). */
const SAMPLE_DELIVERY_PAID: Readonly<Record<string, number>> = {
  kedron: 750,
  paddington: 500,
  sunnybank: 600,
  inala: 500,
  moorooka: 550,
  'mt-gravatt': 600,
  'logan-road': 650,
};

function line(offerId: string, quantity: number): OrderLine {
  const item = SAMPLE_CART_SOURCE.items[offerId];
  if (!item) throw new Error(`no sample item ${offerId}`);
  return {
    offerId,
    name: item.name,
    category: item.category,
    quantity,
    unitPrice: item.price,
    ...(item.imageUrl === undefined ? {} : { imageUrl: item.imageUrl }),
  };
}

function part(
  sellerId: string,
  status: OrderPart['status'],
  lines: readonly OrderLine[],
  extra: { deliveredOn?: string; note?: string; pickup?: PickupCode } = {},
): OrderPart {
  const seller = SAMPLE_CART_SOURCE.sellers[sellerId];
  if (!seller) throw new Error(`no sample seller ${sellerId}`);
  return {
    sellerId,
    sellerName: seller.name,
    status,
    deliveryMethod: 'scheduled',
    deliveryFee: money(SAMPLE_DELIVERY_PAID[sellerId] ?? 500),
    lines,
    ...extra,
  };
}

/** The order with its GST share (1/11 of the total, the prototype's figure; a sample). */
function order(fields: Omit<AccountOrder, 'includedTax'>): AccountOrder {
  let total = 0;
  for (const p of fields.parts) {
    total += p.deliveryFee.amount;
    for (const l of p.lines) total += l.unitPrice.amount * l.quantity;
  }
  return { ...fields, includedTax: money(Math.round(total / 11)) };
}

const HOME = 'Home: 12 Example Street, Kedron QLD 4031';

export const SAMPLE_ACCOUNT: AccountSource = {
  live: false,
  customer: SAMPLE_CHECKOUT.customer,
  mobile: '0400 000 000',
  orders: [
    order({
      reference: 'MP-20481',
      placedOn: '2026-10-19',
      status: 'in-progress',
      deliveredTo: HOME,
      parts: [
        part('kedron', 'confirmed', [line('whole-chicken', 1), line('brisket', 1)], {
          note: 'Please ring the bell twice.',
        }),
        part('mt-gravatt', 'out-for-delivery', [line('bananas', 2)]),
      ],
    }),
    // Collected in person: the seller marked the part ready, so the code is live (a sample).
    order({
      reference: 'MP-20503',
      placedOn: '2026-10-20',
      status: 'in-progress',
      deliveredTo: HOME,
      parts: [
        part('paddington', 'confirmed', [line('sourdough', 1)], {
          pickup: { code: '0427', attemptsLeft: 5, locked: false },
        }),
      ],
    }),
    order({
      reference: 'MP-20412',
      placedOn: '2026-10-16',
      status: 'in-progress',
      deliveredTo: HOME,
      parts: [part('inala', 'waiting', [line('medjool', 1), line('saffron', 2)])],
    }),
    order({
      reference: 'MP-20377',
      placedOn: '2026-10-12',
      status: 'delivered',
      deliveredTo: 'Work: Level 3, 100 Sample Road, Brisbane City QLD 4000',
      parts: [
        part('paddington', 'delivered', [line('sourdough', 2)], { deliveredOn: '2026-10-13' }),
      ],
    }),
    order({
      reference: 'MP-20290',
      placedOn: '2026-10-03',
      status: 'cancelled',
      deliveredTo: HOME,
      parts: [part('sunnybank', 'cancelled', [line('basmati', 1)])],
    }),
  ],
  lists: [
    { id: 'weekly', name: 'Weekly basics', offerIds: ['whole-chicken', 'flatbread', 'bananas'] },
  ],
  emails: { offers: true, recommendations: false, sellerMessages: true },
  serviceArea: SAMPLE_CHECKOUT.serviceArea,
};
