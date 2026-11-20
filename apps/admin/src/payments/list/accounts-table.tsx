'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { EmptyWord, ShortIdCell, TimeCell } from '../../sales/cells.tsx';
import { shortId } from '../../shared/short-id.ts';
import { AccountStatusBadge, FlagBadge } from '../status-badge.tsx';
import type { OptionalColumn } from './accounts-columns.ts';
import type { AccountListRow } from './accounts-list-types.ts';

/**
 * The connected accounts of one page (`SuperTable`): a box to select the row, the seller, the
 * status, ready for payouts and the details due, then the optional columns the admin chose, and
 * the row Actions menu last. From 1024 px a table; below it each account is a card (the seller as
 * its title, the status in its corner). Times are in the admin's zone.
 */
export function AccountsTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly AccountListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: AccountListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('payments.accounts');
  const tl = useTranslations('payments.accounts.list');
  const name = (row: AccountListRow) => row.sellerName?.trim() || t('unnamed');

  const optional = (column: OptionalColumn, row: AccountListRow): ReactNode => {
    switch (column) {
      case 'cooling-off':
        return <TimeCell at={row.coolingOffUntil} zone={zone} empty={tl('none')} />;
      case 'paused':
        return <FlagBadge on={row.payoutsPaused} tone="attention" />;
      case 'last-read':
        return <TimeCell at={row.lastReadAt} zone={zone} empty={tl('never')} />;
      case 'seller-id':
        return <ShortIdCell id={row.sellerId} />;
    }
  };

  const defs: SuperColumn<AccountListRow>[] = [
    {
      id: 'seller',
      header: tl('col.seller'),
      primary: true,
      headClassName: 'min-w-48',
      cell: (row) => (
        <>
          <a
            className="font-medium wrap-anywhere text-link underline"
            href={`/payout-accounts/${encodeURIComponent(row.sellerId)}`}
            title={row.sellerId}
          >
            {name(row)}
          </a>
          <span className="block text-xs text-fg-muted">{shortId(row.sellerId)}</span>
        </>
      ),
    },
    {
      id: 'status',
      header: tl('col.status'),
      corner: true,
      cell: (row) => <AccountStatusBadge status={row.status} />,
    },
    {
      id: 'ready',
      header: tl('col.ready'),
      cell: (row) => <FlagBadge on={row.ready} tone="success" />,
    },
    {
      id: 'requirements',
      header: tl('col.requirements'),
      numeric: true,
      cell: (row) => (
        <span>
          {row.requirementsDue === 0 ? <EmptyWord>{tl('none')}</EmptyWord> : row.requirementsDue}
          {row.requirementsPastDue ? (
            <span className="block text-critical-fg">{t('past-due')}</span>
          ) : null}
        </span>
      ),
    },
    ...columns.map((column): SuperColumn<AccountListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<AccountListRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.sellerId}
      rowName={name}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: tl('select.page'),
          pageShort: tl('select.page-short'),
          row: (label) => tl('select.row', { name: label }),
        },
      }}
      actions={{
        header: tl('col.actions'),
        label: (label) => tl('actions.for', { name: label }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass="lg:min-w-240"
    />
  );
}
