'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { known } from '../../sellers/format.ts';
import { shortId } from '../../shared/short-id.ts';
import { EmptyWord, MoneyCell, OrderLink, ShortIdCell, StoreCell, TimeCell } from '../cells.tsx';
import { CustomerCell } from '../customer-cell.tsx';
import { MONEY_COLUMNS, columnsOnTab, type OptionalColumn } from './invoices-columns.ts';
import type { DocumentRow, Tab } from './invoices-types.ts';

/** The refund reasons the order page words; any other value reads "Other". */
const REASONS = [
  'not-received',
  'damaged',
  'wrong-item',
  'not-as-described',
  'seller-cancelled',
  'item-unavailable',
  'other',
] as const;

/**
 * The documents of one page, from one column definition (`SuperTable`): a box to select the row,
 * the order reference, then the columns the admin chose in their order (those for credit notes
 * only are skipped on the confirmations tab), and the row Actions menu last. From 1024 px a
 * table; below it each document is a card with labelled lines. Times are in `zone`, the viewer's own zone (named in the Help panel and the account menu); money is in
 * each row's own currency.
 */
export function InvoicesTable({
  rows,
  tab,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly DocumentRow[];
  readonly tab: Tab;
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /** The first load: this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: DocumentRow) => readonly MenuItem[];
}) {
  const t = useTranslations('invoices');
  const tr = useTranslations('orders.actions.refund-reason');
  const content = (column: OptionalColumn, row: DocumentRow): ReactNode => {
    switch (column) {
      case 'issued':
        return <TimeCell at={row.issuedAt} zone={zone} />;
      case 'store':
        return <StoreCell storeName={row.storeName} sellerId={row.sellerId} />;
      case 'customer':
        return <CustomerCell customer={row.customer} accountId={row.accountId} />;
      case 'total':
        return <MoneyCell money={row.total} strong />;
      case 'tax':
        return row.tax === null ? (
          <span title={t('tax-not-recorded-title')}>
            <EmptyWord>{t('not-recorded')}</EmptyWord>
          </span>
        ) : (
          <MoneyCell money={row.tax} />
        );
      case 'reason':
        return row.refundReason === null ? (
          <EmptyWord>{t('not-recorded')}</EmptyWord>
        ) : (
          <span>{tr(known(row.refundReason, REASONS))}</span>
        );
      case 'shipping':
        return <MoneyCell money={row.shipping} />;
      case 'sellerOrderId':
        return <ShortIdCell id={row.sellerOrderId} />;
      case 'documentId':
        return <ShortIdCell id={row.documentId} />;
      case 'refundId':
        return row.refundId === null ? (
          <EmptyWord>{t('not-recorded')}</EmptyWord>
        ) : (
          <ShortIdCell id={row.refundId} />
        );
    }
  };

  const defs: SuperColumn<DocumentRow>[] = [
    {
      id: 'order',
      header: t('col.order'),
      primary: true,
      cell: (row) => <OrderLink orderId={row.orderId} />,
    },
    ...columnsOnTab(columns, tab).map((column): SuperColumn<DocumentRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: MONEY_COLUMNS.includes(column),
      ...(column === 'issued' ? { skeleton: 'date' as const } : {}),
      cell: (row) => content(column, row),
    })),
  ];

  return (
    <SuperTable<DocumentRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.documentId}
      rowName={(row) => t('row-name', { id: shortId(row.orderId) })}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: t('select.page', { kind: tab === 'credit-note' ? 'credit' : 'confirmation' }),
          pageShort: t('select.page-short'),
          row: (name) => t('select.row', { name }),
        },
      }}
      actions={{
        header: t('actions.header'),
        label: (name) => t('actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={
        defs.length > 9
          ? 'lg:min-w-480'
          : defs.length > 5
            ? 'lg:min-w-360'
            : defs.length > 3
              ? 'lg:min-w-300'
              : 'lg:min-w-240'
      }
    />
  );
}
