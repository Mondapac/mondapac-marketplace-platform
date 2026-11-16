import { minorUnitExponent } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';
import type { ExportCell } from '../../../platform/list-export';
import type { LabelledAdminOrderView, LabelledSellerOrderDetailView } from '../domain/order-views';

// The CSV of the order exports (admin and seller panels): pure text functions, no I/O. The file is
// data, not a page: headers are English. It holds no customer name, email or address.

export type Cell = ExportCell;

/**
 * Minor units as a plain decimal ("12.50", "-3.00", "1200" for a zero-exponent currency). Written
 * as text with no currency sign, so a spreadsheet reads a number and nothing is lost to rounding.
 */
export function decimalOf(money: Money): string {
  const exponent = minorUnitExponent(money.currency);
  const negative = money.amount < 0n;
  const digits = (negative ? -money.amount : money.amount).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;
}

const moneyCell = (value: Money | null): string => (value === null ? '' : decimalOf(value));

export const ADMIN_ORDERS_HEADER: readonly string[] = [
  'Order',
  'Placed',
  'Status',
  'Payment',
  'Currency',
  'Total',
  'Tax',
  'Sellers',
  'Stores',
  'Fulfilment',
  'Paid at',
  'Cancelled at',
];

/** One admin order as a row: the order, never its buyer. */
export function adminOrderRow(order: LabelledAdminOrderView): readonly Cell[] {
  const steps = [...new Set(order.sellerOrders.map((seller) => seller.fulfilment))];
  return [
    order.orderId,
    order.createdAt.toString(),
    order.status,
    order.paymentState,
    order.total.currency,
    decimalOf(order.total),
    moneyCell(order.tax),
    order.sellerOrders.length,
    order.sellerOrders.map((seller) => seller.storeName ?? '').join('; '),
    steps.join('; '),
    order.confirmedAt?.toString() ?? '',
    order.cancelledAt?.toString() ?? '',
  ];
}

export const SELLER_ORDERS_HEADER: readonly string[] = [
  'Seller order',
  'Order',
  'Paid at',
  'Fulfilment',
  'Delivery method',
  'Items',
  'Currency',
  'Subtotal',
  'Shipping',
  'Tax',
  'Total',
  'Carrier',
  'Tracking reference',
  'Ready at',
  'Shipped at',
  'Delivered at',
];

/** One seller order as a row: no buyer name, email, phone or address. */
export function sellerOrderRow(order: LabelledSellerOrderDetailView): readonly Cell[] {
  return [
    order.sellerOrderId,
    order.orderId,
    order.paidAt.toString(),
    order.fulfilment,
    order.deliveryMethod,
    order.lines.reduce((sum, line) => sum + line.quantity, 0),
    order.total.currency,
    decimalOf(order.subtotal),
    decimalOf(order.shipping),
    moneyCell(order.tax),
    decimalOf(order.total),
    order.carrier ?? '',
    order.trackingRef ?? '',
    order.readyAt?.toString() ?? '',
    order.shippedAt?.toString() ?? '',
    order.deliveredAt?.toString() ?? '',
  ];
}
