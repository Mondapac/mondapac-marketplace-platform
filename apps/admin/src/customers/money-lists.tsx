'use client';

import { Badge, type SuperColumn } from '@mondapac/ui';
import { orderHref } from '../orders/order-href.ts';
import { shortId } from '../shared/short-id.ts';
import { formatMinor } from '../wallet/money.ts';
import { dayOf, timeOf } from './format.ts';
import type { CellContext, MoneyListSpec } from './money-list.tsx';
import type {
  DisputeRow,
  ListAnswer,
  MoneyAmount,
  PaymentRow,
  PaymentsAnswer,
  RefundRow,
} from './money-types.ts';

// Customers phase 2b, part A: the three super lists of the Money tab, as data for `MoneyList`.
// Every closed value below is the API's own (payments.customer-payments-flow, ordering's refund
// reasons, Stripe's dispute states); a value a newer API adds is shown as its raw code.

export const PAYMENTS_VIEW = 'payments.customer-payment.view';
export const ORDERS_VIEW_KEY = 'ordering.order.view';

const maybe = (ctx: CellContext, key: string, value: string): string =>
  ctx.t.has(`${key}.${value}`) ? ctx.t(`${key}.${value}`) : value;

const money = (ctx: CellContext, value: MoneyAmount): string =>
  formatMinor(value.amount, value.currency, ctx.locale);

const dash = <span className="text-fg-muted">—</span>;

function orderColumn<Row extends { readonly orderId: string }>(ctx: CellContext): SuperColumn<Row> {
  return {
    id: 'order',
    header: ctx.t('col.order'),
    primary: true,
    cell: (row) => (
      <a
        className="font-medium text-link underline wrap-anywhere"
        href={orderHref(row.orderId, { accountId: ctx.accountId, tab: 'money' })}
        title={row.orderId}
      >
        {ctx.t('order', { id: shortId(row.orderId) })}
      </a>
    ),
  };
}

const amountColumn = <Row extends { readonly amount: MoneyAmount }>(
  ctx: CellContext,
): SuperColumn<Row> => ({
  id: 'amount',
  header: ctx.t('col.amount'),
  numeric: true,
  cell: (row) => money(ctx, row.amount),
});

export const PAYMENTS_SPEC: MoneyListSpec<PaymentRow, PaymentsAnswer> = {
  kind: 'payments',
  prefs: 'customer-payments-columns',
  path: (id) => `payments/admin/customers/${encodeURIComponent(id)}/payments`,
  viewKey: PAYMENTS_VIEW,
  sorts: ['created', 'amount'],
  defaultSort: 'created',
  dateSorts: ['created'],
  viewFilterKey: 'paymentState',
  views: [
    { id: 'all', values: [] },
    { id: 'captured', values: ['captured'] },
    { id: 'authorised', values: ['authorised'] },
    { id: 'voided', values: ['voided'] },
    { id: 'none', values: ['none'] },
  ],
  choice: { key: 'status', values: ['pending-payment', 'confirmed', 'cancelled'] },
  fixed: ['order', 'amount'],
  optional: ['payment-state', 'status', 'payment-id', 'created', 'confirmed'],
  defaultOptional: ['payment-state', 'status', 'created'],
  rowId: (row) => row.orderId,
  rowName: (row) => row.orderId,
  orderOf: (row) => row.orderId,
  columns: (ctx) => ({
    first: [orderColumn<PaymentRow>(ctx)],
    optional: (id) => {
      switch (id) {
        case 'payment-state':
          return {
            id,
            header: ctx.t('col.payment-state'),
            corner: true,
            cell: (row) => (
              <Badge
                tone={
                  row.paymentState === 'captured'
                    ? 'success'
                    : row.paymentState === 'voided'
                      ? 'neutral'
                      : 'attention'
                }
              >
                {maybe(ctx, 'payment-state', row.paymentState)}
              </Badge>
            ),
          };
        case 'status':
          return {
            id,
            header: ctx.t('col.status'),
            cell: (row) => maybe(ctx, 'status', row.status),
          };
        case 'payment-id':
          return {
            id,
            header: ctx.t('col.payment-id'),
            cell: (row) =>
              row.providerPaymentId === null ? (
                dash
              ) : (
                <span className="font-mono text-xs wrap-anywhere">{row.providerPaymentId}</span>
              ),
          };
        case 'confirmed':
          return {
            id,
            header: ctx.t('col.confirmed'),
            cell: (row) =>
              row.confirmedAt === null ? dash : timeOf(row.confirmedAt, ctx.locale, ctx.zone),
          };
        default:
          return {
            id: 'created',
            header: ctx.t('col.created'),
            cell: (row) => timeOf(row.createdAt, ctx.locale, ctx.zone),
          };
      }
    },
    last: [amountColumn<PaymentRow>(ctx)],
  }),
  // Paid is the gross captured total, one sum per currency; refunds are not taken off.
  note: (answer, ctx) =>
    answer.paid.length === 0
      ? undefined
      : ctx.t('paid', { amount: answer.paid.map((sum) => money(ctx, sum)).join(' + ') }),
};

const DISPUTE_OPEN = [
  'warning_needs_response',
  'needs_response',
  'warning_under_review',
  'under_review',
];

export const DISPUTES_SPEC: MoneyListSpec<DisputeRow, ListAnswer<DisputeRow>> = {
  kind: 'disputes',
  prefs: 'customer-disputes-columns',
  path: (id) => `payments/admin/customers/${encodeURIComponent(id)}/disputes`,
  viewKey: PAYMENTS_VIEW,
  sorts: ['opened', 'amount', 'due'],
  defaultSort: 'opened',
  dateSorts: ['opened', 'due'],
  viewFilterKey: 'status',
  views: [
    { id: 'all', values: [] },
    { id: 'open', values: DISPUTE_OPEN },
    { id: 'won', values: ['won'] },
    { id: 'lost', values: ['lost'] },
    { id: 'closed', values: ['warning_closed', 'prevented'] },
  ],
  choice: null,
  fixed: ['order', 'amount'],
  optional: ['status', 'reason', 'opened', 'due', 'outcome'],
  defaultOptional: ['status', 'reason', 'opened', 'due'],
  rowId: (row) => row.disputeId,
  rowName: (row) => row.disputeId,
  orderOf: (row) => row.orderId,
  columns: (ctx) => ({
    first: [orderColumn<DisputeRow>(ctx)],
    optional: (id) => {
      switch (id) {
        case 'status':
          return {
            id,
            header: ctx.t('col.status'),
            corner: true,
            cell: (row) => (
              <Badge
                tone={
                  row.status === 'won' || row.status === 'prevented'
                    ? 'success'
                    : row.status === 'lost'
                      ? 'critical'
                      : DISPUTE_OPEN.includes(row.status)
                        ? 'attention'
                        : 'neutral'
                }
              >
                {maybe(ctx, 'status', row.status)}
              </Badge>
            ),
          };
        case 'reason':
          return {
            id,
            header: ctx.t('col.reason'),
            cell: (row) => maybe(ctx, 'reason', row.reason),
          };
        case 'due':
          return {
            id,
            header: ctx.t('col.due'),
            cell: (row) =>
              row.evidenceDueBy === null ? dash : timeOf(row.evidenceDueBy, ctx.locale, ctx.zone),
          };
        case 'outcome':
          return {
            id,
            header: ctx.t('col.outcome'),
            cell: (row) => (row.outcome === null ? dash : maybe(ctx, 'outcome', row.outcome)),
          };
        default:
          return {
            id: 'opened',
            header: ctx.t('col.opened'),
            cell: (row) => timeOf(row.openedAt, ctx.locale, ctx.zone),
          };
      }
    },
    last: [amountColumn<DisputeRow>(ctx)],
  }),
};

export const REFUNDS_SPEC: MoneyListSpec<RefundRow, ListAnswer<RefundRow>> = {
  kind: 'refunds',
  prefs: 'customer-refunds-columns',
  path: (id) => `ordering/admin/customers/${encodeURIComponent(id)}/refunds`,
  viewKey: ORDERS_VIEW_KEY,
  sorts: ['requested', 'amount'],
  defaultSort: 'requested',
  dateSorts: ['requested'],
  viewFilterKey: 'state',
  views: [
    { id: 'all', values: [] },
    { id: 'succeeded', values: ['succeeded'] },
    { id: 'pending', values: ['pending'] },
    { id: 'failed', values: ['failed'] },
  ],
  choice: {
    key: 'reason',
    values: [
      'not-received',
      'damaged',
      'wrong-item',
      'not-as-described',
      'seller-cancelled',
      'other',
      'item-unavailable',
    ],
  },
  fixed: ['order', 'amount'],
  optional: ['state', 'reason', 'requested', 'settled', 'credit-note'],
  defaultOptional: ['state', 'requested', 'credit-note'],
  rowId: (row) => row.refundId,
  rowName: (row) => row.refundId,
  orderOf: (row) => row.orderId,
  columns: (ctx) => ({
    first: [orderColumn<RefundRow>(ctx)],
    optional: (id) => {
      switch (id) {
        case 'state':
          return {
            id,
            header: ctx.t('col.state'),
            corner: true,
            cell: (row) => (
              <Badge
                tone={
                  row.state === 'succeeded'
                    ? 'success'
                    : row.state === 'failed'
                      ? 'critical'
                      : 'attention'
                }
              >
                {maybe(ctx, 'state', row.state)}
              </Badge>
            ),
          };
        case 'reason':
          return {
            id,
            header: ctx.t('col.reason'),
            cell: (row) => maybe(ctx, 'choice.value', row.reason),
          };
        case 'settled':
          return {
            id,
            header: ctx.t('col.settled'),
            cell: (row) =>
              row.settledAt === null ? dash : dayOf(row.settledAt, ctx.locale, ctx.zone),
          };
        case 'credit-note':
          return {
            id,
            header: ctx.t('col.credit-note'),
            cell: (row) =>
              row.creditNoteId === null ? (
                <span className="text-fg-muted">{ctx.t('no-credit-note')}</span>
              ) : (
                <span className="font-mono text-xs wrap-anywhere">{row.creditNoteId}</span>
              ),
          };
        default:
          return {
            id: 'requested',
            header: ctx.t('col.requested'),
            cell: (row) => dayOf(row.requestedAt, ctx.locale, ctx.zone),
          };
      }
    },
    last: [amountColumn<RefundRow>(ctx)],
  }),
};
