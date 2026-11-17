import type { ExportCell } from '../../../platform/list-export';
import type { DocumentListRow } from '../domain/admin-document-list';
import type { RefundListRow } from '../domain/admin-refund-list';
import type { ShipmentListRow } from '../domain/admin-shipment-list';
import type { OrderCustomerView } from '../domain/order-views';
import { moneyCells, moneyHeaders, zonedText, type ExportColumnSpec } from './sales-list-export';

// The columns of the three Sales list exports (Reza's spec 1.8, 2.8, 3.8). Each key is the
// column's key in the page's column picker; a key stands for one column on screen and may write
// more than one in the file (a money value and its currency, a store and its seller id). Headers
// are English (the file is data). Codes (stage, state, reason, ...) are written as the API's
// codes; ids in full; an empty value is an empty cell.

type Column<Row> = ExportColumnSpec<Row>;

const text = (value: string | null): ExportCell => value ?? '';

/** Customer name and email: empty unless the admin may see customers (the list leaves it null). */
const customerCells = (customer: OrderCustomerView | null): readonly ExportCell[] => [
  text(customer?.displayName ?? null),
  text(customer?.email ?? null),
];

const storeColumn = <
  Row extends { storeName: string | null; sellerId: string },
>(): Column<Row> => ({
  key: 'store',
  fixed: false,
  headers: ['Store', 'Seller ID'],
  cells: (row) => [text(row.storeName), row.sellerId],
});

const customerColumn = <Row extends { customer: OrderCustomerView | null }>(): Column<Row> => ({
  key: 'customer',
  fixed: false,
  headers: ['Customer', 'Customer email'],
  cells: (row) => customerCells(row.customer),
});

/** Shipments (spec 1.8): fixed Order and Stage, then the picker's columns. */
export const SHIPMENT_EXPORT_COLUMNS: readonly Column<ShipmentListRow>[] = [
  { key: 'order', fixed: true, headers: ['Order ID'], cells: (row) => [row.orderId] },
  {
    key: 'sellerOrderId',
    fixed: false,
    headers: ['Seller order ID'],
    cells: (row) => [row.sellerOrderId],
  },
  {
    key: 'stage',
    fixed: true,
    headers: ['Stage', 'Delivery problem'],
    cells: (row) => [row.stage, text(row.deliveryAttention)],
  },
  storeColumn(),
  customerColumn(),
  {
    key: 'paid',
    fixed: false,
    headers: ['Paid'],
    cells: (row, at) => [zonedText(row.paidAt, at.zone)],
  },
  {
    key: 'delivery',
    fixed: false,
    headers: ['Delivery method', 'Window start', 'Window end'],
    cells: (row, at) => [
      row.deliveryMethod,
      zonedText(row.deliveryWindow?.start ?? null, at.zone),
      zonedText(row.deliveryWindow?.end ?? null, at.zone),
    ],
  },
  {
    key: 'carrier',
    fixed: false,
    headers: ['Carrier', 'Tracking reference'],
    cells: (row) => [text(row.carrier), text(row.trackingRef)],
  },
  { key: 'fleet', fixed: false, headers: ['Fleet'], cells: (row) => [text(row.fleet)] },
  {
    key: 'ready',
    fixed: false,
    headers: ['Ready'],
    cells: (row, at) => [zonedText(row.readyAt, at.zone)],
  },
  {
    key: 'shipped',
    fixed: false,
    headers: ['Shipped'],
    cells: (row, at) => [zonedText(row.shippedAt, at.zone)],
  },
  {
    key: 'delivered',
    fixed: false,
    headers: ['Delivered'],
    cells: (row, at) => [zonedText(row.deliveredAt, at.zone)],
  },
  {
    key: 'shipping',
    fixed: false,
    headers: moneyHeaders('Delivery fee (incl. tax)'),
    cells: (row) => moneyCells(row.shipping),
  },
  {
    key: 'total',
    fixed: false,
    headers: moneyHeaders('Total (incl. tax)'),
    cells: (row) => moneyCells(row.total),
  },
  {
    key: 'refunded',
    fixed: false,
    headers: moneyHeaders('Refunded (incl. tax)'),
    cells: (row) => moneyCells(row.refunded),
  },
];

/** Refunds (spec 2.8): fixed Order and State, then the picker's columns. */
export const REFUND_EXPORT_COLUMNS: readonly Column<RefundListRow>[] = [
  { key: 'refundId', fixed: false, headers: ['Refund ID'], cells: (row) => [row.refundId] },
  { key: 'order', fixed: true, headers: ['Order ID'], cells: (row) => [row.orderId] },
  {
    key: 'sellerOrderId',
    fixed: false,
    headers: ['Seller order ID'],
    cells: (row) => [row.sellerOrderId],
  },
  { key: 'state', fixed: true, headers: ['State'], cells: (row) => [row.state] },
  {
    key: 'amount',
    fixed: false,
    headers: moneyHeaders('Amount (incl. tax)'),
    cells: (row) => moneyCells(row.gross),
  },
  { key: 'tax', fixed: false, headers: moneyHeaders('Tax'), cells: (row) => moneyCells(row.tax) },
  {
    key: 'shipping',
    fixed: false,
    headers: moneyHeaders('Delivery part (incl. tax)'),
    cells: (row) => moneyCells(row.shippingGross),
  },
  { key: 'reason', fixed: false, headers: ['Reason'], cells: (row) => [row.reason] },
  { key: 'actor', fixed: false, headers: ['Requested by'], cells: (row) => [row.actor] },
  {
    key: 'lossBearer',
    fixed: false,
    headers: ['Loss borne by', 'Loss reason'],
    cells: (row) => [row.lossBearer, text(row.lossReasonCode)],
  },
  storeColumn(),
  customerColumn(),
  {
    key: 'requested',
    fixed: false,
    headers: ['Requested'],
    cells: (row, at) => [zonedText(row.requestedAt, at.zone)],
  },
  {
    key: 'settled',
    fixed: false,
    headers: ['Settled'],
    cells: (row, at) => [zonedText(row.settledAt, at.zone)],
  },
  {
    key: 'ledger',
    fixed: false,
    headers: ['Seller ledger recorded'],
    cells: (row, at) => [zonedText(row.ledgerRecordedAt, at.zone)],
  },
  {
    key: 'stripeRefundId',
    fixed: false,
    headers: ['Stripe refund ID'],
    cells: (row) => [text(row.stripeRefundId)],
  },
  {
    key: 'creditNote',
    fixed: false,
    headers: ['Credit note ID'],
    cells: (row) => [text(row.creditNoteId)],
  },
];

/** Columns only the credit notes tab has (spec 3.3); the confirmations file skips them. */
export const CREDIT_NOTE_ONLY_COLUMNS: ReadonlySet<string> = new Set([
  'documentId',
  'refundId',
  'reason',
]);

const shared: readonly Column<DocumentListRow>[] = [
  { key: 'order', fixed: true, headers: ['Order ID'], cells: (row) => [row.orderId] },
  {
    key: 'sellerOrderId',
    fixed: false,
    headers: ['Seller order ID'],
    cells: (row) => [row.sellerOrderId],
  },
];

const people: readonly Column<DocumentListRow>[] = [
  storeColumn(),
  customerColumn(),
  {
    key: 'issued',
    fixed: false,
    headers: ['Issued'],
    cells: (row, at) => [zonedText(row.issuedAt, at.zone)],
  },
  {
    key: 'total',
    fixed: false,
    headers: moneyHeaders('Total (incl. tax)'),
    cells: (row) => moneyCells(row.total),
  },
  { key: 'tax', fixed: false, headers: moneyHeaders('Tax'), cells: (row) => moneyCells(row.tax) },
  {
    key: 'shipping',
    fixed: false,
    headers: moneyHeaders('Delivery (incl. tax)'),
    cells: (row) => moneyCells(row.shipping),
  },
];

/**
 * Invoices, order confirmations tab (spec 3.8): no number column (these are not tax invoices).
 * The credit-note-only keys are accepted and skipped, as the page skips them on this tab.
 */
export const CONFIRMATION_EXPORT_COLUMNS: readonly Column<DocumentListRow>[] = [
  ...shared,
  ...people,
];

/** Invoices, credit notes tab (spec 3.8): the credit note, its refund and reason first. */
export const CREDIT_NOTE_EXPORT_COLUMNS: readonly Column<DocumentListRow>[] = [
  {
    key: 'documentId',
    fixed: false,
    headers: ['Credit note ID'],
    cells: (row) => [row.documentId],
  },
  {
    key: 'refundId',
    fixed: false,
    headers: ['Refund ID'],
    cells: (row) => [text(row.refundId)],
  },
  ...shared,
  {
    key: 'reason',
    fixed: false,
    headers: ['Reason'],
    cells: (row) => [text(row.refundReason)],
  },
  ...people,
];
