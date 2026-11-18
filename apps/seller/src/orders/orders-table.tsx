'use client';

import {
  Badge,
  SuperTable,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import type { OrderColumn } from './orders-columns.ts';
import { shortId, statusOf, TONE } from './status.ts';
import type { SellerOrderRow } from './types.ts';

/**
 * The paid orders of one page, from one column definition (`SuperTable`): a box to select the row,
 * the reference (the link to the order), the status, then the columns the seller chose in their
 * order, and the row Actions menu last. From 1024 px a table; below it each order is a card with
 * labelled lines. Times are on the seller's own clock; money is in each order's own currency.
 */
export function OrdersTable({
  rows,
  columns,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly SellerOrderRow[];
  readonly columns: readonly OrderColumn[];
  readonly selection: RowSelectionState;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /** The first load: this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: SellerOrderRow) => readonly MenuItem[];
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const zone = useTimeZone();
  const content = (column: OrderColumn, order: SellerOrderRow): ReactNode => {
    switch (column) {
      case 'paid':
        return <time dateTime={order.paidAt}>{shortInstant(order.paidAt, locale, zone)}</time>;
      case 'delivery':
        return t(`method.${order.deliveryMethod}`);
      case 'items':
        return order.lines.reduce((sum, line) => sum + line.quantity, 0);
      case 'total':
        return (
          <span className="font-medium">
            {formatMinor(order.total.amount, order.total.currency, locale)}
          </span>
        );
    }
  };

  const defs: SuperColumn<SellerOrderRow>[] = [
    {
      id: 'order',
      header: t('col.order'),
      primary: true,
      cell: (order) => (
        <a className="font-medium text-link underline" href={`/orders/${order.sellerOrderId}`}>
          {t('ref', { id: shortId(order.sellerOrderId) })}
        </a>
      ),
    },
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (order) => <Badge tone={TONE[statusOf(order)]}>{t(`status.${statusOf(order)}`)}</Badge>,
    },
    ...columns.map((column): SuperColumn<SellerOrderRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: column === 'items' || column === 'total',
      ...(column === 'paid' ? { skeleton: 'date' as const } : {}),
      cell: (order) => content(column, order),
    })),
  ];

  return (
    <SuperTable<SellerOrderRow>
      caption={t('title')}
      rows={rows}
      rowId={(order) => order.sellerOrderId}
      rowName={(order) => t('row-name', { id: shortId(order.sellerOrderId) })}
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
      minWidthClass={columns.length > 3 ? 'lg:min-w-240' : 'lg:min-w-180'}
    />
  );
}
