import { minorUnitExponent } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';
import type { LabelledAdminOrderView, LabelledSellerOrderDetailView } from '../domain/order-views';

// The CSV of the order exports (admin and seller panels): pure text functions, no I/O. The file is
// data, not a page: headers are English. It holds no customer name, email or address.

/** Orders (or seller orders) one export may hold; more is refused whole and the caller narrows the filter. */
export const ORDERS_EXPORT_MAX_ROWS = 10_000;

export type Cell = string | number | null;

/** The byte order mark that makes a spreadsheet read the file as UTF-8. */
export const CSV_BOM = '﻿';

/**
 * Spreadsheets run a cell that starts with one of these as a formula (CSV injection, OWASP). The
 * test looks past leading whitespace and covers the fullwidth signs of `= + - @`.
 */
const FORMULA_START = /^\s*[=+\-@\t\r＝＋－＠]/u;

/** One cell as text: a formula-like text gets a leading quote; then RFC 4180 quoting. */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One line of cells, ending in CRLF. */
export function csvLine(cells: readonly Cell[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

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

/** The file as chunks: the byte order mark and header first, then a chunk per page of rows. */
export async function* csvChunks(
  header: readonly string[],
  pages: AsyncIterable<readonly (readonly Cell[])[]>,
): AsyncGenerator<string> {
  yield CSV_BOM + csvLine(header);
  for await (const page of pages) yield page.map(csvLine).join('');
}
