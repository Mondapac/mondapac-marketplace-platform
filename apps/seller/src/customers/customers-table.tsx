'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import type { CustomerColumn } from './columns.ts';
import { CustomerBadges } from './customer-badges.tsx';
import type { SellerCustomerRow } from './types.ts';

/** A customer code, in a fixed-width face and always left to right (it is not a word). */
export function CodeText({ code }: { readonly code: string }) {
  return (
    <span dir="ltr" className="font-mono font-medium tracking-wide">
      {code}
    </span>
  );
}

/**
 * The customers of one page from one column definition (`SuperTable`): a box to select the row (so
 * "select all matching" can feed the export), the code (a link to the customer), the columns the
 * seller chose, and the row Actions menu last. Below 1024 px each customer is a card. Times are in
 * the seller's zone (named in the Help panel and the account menu, not on the page); money is in the currency the API gives, never a default.
 */
export function CustomersTable({
  rows,
  columns,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly SellerCustomerRow[];
  readonly columns: readonly CustomerColumn[];
  /** Null when the seller may not export: nothing to select rows for. */
  readonly selection: RowSelectionState | null;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: SellerCustomerRow) => readonly MenuItem[];
}) {
  const t = useTranslations('customers');
  const locale = useLocale();
  const zone = useTimeZone();
  const when = (iso: string | null): ReactNode =>
    iso === null ? (
      <span aria-label={t('none')}>-</span>
    ) : (
      <time dateTime={iso}>{shortInstant(iso, locale, zone)}</time>
    );
  const content = (column: CustomerColumn, row: SellerCustomerRow): ReactNode => {
    switch (column) {
      case 'firstName':
        return row.firstName ?? <span aria-label={t('none')}>-</span>;
      case 'orders':
        return row.orderCount;
      case 'spent':
        return row.spentMinor === null || row.currency === null ? (
          <span aria-label={t('none')}>-</span>
        ) : (
          <span dir="ltr">{formatMinor(row.spentMinor, row.currency, locale)}</span>
        );
      case 'lastOrder':
        return when(row.lastOrderAt);
      case 'firstOrder':
        return when(row.firstOrderAt);
      case 'followed':
        return when(row.followedAt);
      case 'badges':
        return <CustomerBadges customer={row} />;
    }
  };
  const defs: SuperColumn<SellerCustomerRow>[] = [
    {
      id: 'code',
      header: t('col.code'),
      primary: true,
      cell: (row) => (
        <a className="text-link underline" href={`/customers/${encodeURIComponent(row.code)}`}>
          <CodeText code={row.code} />
        </a>
      ),
    },
    ...columns.map((column): SuperColumn<SellerCustomerRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: column === 'orders' || column === 'spent',
      ...(column === 'lastOrder' || column === 'firstOrder' || column === 'followed'
        ? { skeleton: 'date' as const }
        : {}),
      cell: (row) => content(column, row),
    })),
  ];
  return (
    <SuperTable<SellerCustomerRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.code}
      rowName={(row) => row.code}
      columns={defs}
      {...(selection === null
        ? {}
        : {
            selection: {
              state: selection,
              labels: {
                page: t('select.page'),
                pageShort: t('select.page-short'),
                row: (name: string) => t('select.row', { name }),
              },
            },
          })}
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
