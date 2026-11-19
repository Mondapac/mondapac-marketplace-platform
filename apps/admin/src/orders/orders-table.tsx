'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { CustomerCell } from '../sales/customer-cell.tsx';
import { MoneyCell, OrderLink, TimeCell } from '../sales/cells.tsx';
import { known } from '../sellers/format.ts';
import { shortId } from '../shared/short-id.ts';
import { FallbackId } from './fallback-id.tsx';
import type { OrderColumn } from './orders-columns.ts';
import { orderHref, type CustomerOrigin } from './order-href.ts';
import { OrderStatusBadge } from './status-badge.tsx';
import { PAYMENT_STATES, type AdminOrderRow } from './types.ts';

/** One line per seller part: the shop name, or the short id when the name is unknown. */
function SellerNames({ order }: { readonly order: AdminOrderRow }) {
  return (
    <ul className="flex min-w-0 flex-col gap-1 break-words">
      {order.sellerOrders.map((part) => (
        <li key={part.sellerId} title={part.sellerId}>
          {part.storeName?.trim() || <FallbackId id={part.sellerId} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * The orders of one page, from one column definition (`SuperTable`): a box to select the row, the
 * reference, the status, then the columns the admin chose in their order, and the row Actions menu
 * last. From 1024 px a table; below it each order is a card with labelled lines (the reference as
 * its title, the status in its corner). Times are in `zone`, which the page names once.
 */
export function OrdersTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
  fromCustomer,
}: {
  readonly rows: readonly AdminOrderRow[];
  readonly columns: readonly OrderColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /** The first load: this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: AdminOrderRow) => readonly MenuItem[];
  /** Opened from a customer's page: each order's Back returns to that tab. */
  readonly fromCustomer?: CustomerOrigin;
}) {
  const t = useTranslations('orders');
  const content = (column: OrderColumn, order: AdminOrderRow): ReactNode => {
    switch (column) {
      case 'placed':
        return <TimeCell at={order.createdAt} zone={zone} />;
      case 'paid':
        return <TimeCell at={order.confirmedAt} zone={zone} empty={t('not-yet')} />;
      case 'payment':
        return t(`payment.${known(order.paymentState, PAYMENT_STATES)}`);
      case 'customer':
        return <CustomerCell customer={order.customer} accountId={order.accountId} />;
      case 'sellers':
        return <SellerNames order={order} />;
      case 'total':
        return <MoneyCell money={order.total} strong />;
    }
  };

  const defs: SuperColumn<AdminOrderRow>[] = [
    {
      id: 'order',
      header: t('col.order'),
      primary: true,
      cell: (order) => (
        <OrderLink orderId={order.orderId} href={orderHref(order.orderId, fromCustomer)} />
      ),
    },
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (order) => <OrderStatusBadge status={order.status} />,
    },
    ...columns.map((column): SuperColumn<AdminOrderRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: column === 'total',
      ...(column === 'placed' || column === 'paid' ? { skeleton: 'date' as const } : {}),
      cell: (order) => content(column, order),
    })),
  ];

  return (
    <SuperTable<AdminOrderRow>
      caption={t('title')}
      rows={rows}
      rowId={(order) => order.orderId}
      rowName={(order) => t('row-name', { id: shortId(order.orderId) })}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: t('select.page'),
          pageShort: t('select.page-short'),
          row: (name) => t('select.row', { name }),
        },
      }}
      actions={{
        header: t('row-actions.header'),
        label: (name) => t('row-actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={columns.length > 4 ? 'lg:min-w-300' : 'lg:min-w-240'}
    />
  );
}
