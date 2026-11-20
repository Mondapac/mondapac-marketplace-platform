'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { ShortIdCell, TimeCell } from '../../sales/cells.tsx';
import { shortId } from '../../shared/short-id.ts';
import { formatMinor } from '../../wallet/money.ts';
import { BucketBadge } from '../bucket-badge.tsx';
import { EvidenceDueText } from '../evidence-due.tsx';
import { reasonText } from '../evidence.ts';
import { MoneyStateBadge } from '../money-state-badge.tsx';
import type { OptionalColumn } from './disputes-columns.ts';
import { STATUSES, type DisputeListRow } from './disputes-list-types.ts';

/**
 * The cases of one page, from one column definition (`SuperTable`): a box to select the row, the
 * case, its stage, the sellers, the amount and when it was opened, then the optional columns the
 * admin chose, and the row Actions menu last. From 1024 px a table; below it each case is a card
 * with labelled lines (the case as its title, the stage in its corner). No button stands in a
 * row: Open and Decide are in the Actions menu.
 */
export function DisputesTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly DisputeListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: DisputeListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('disputes');
  const tl = useTranslations('disputes.list');
  const locale = useLocale();
  // The deadline badges ("In 2 days", "Overdue") count from when the page opened.
  const [now] = useState(() => Date.now());
  const sellers = (row: DisputeListRow) =>
    row.sellers.length === 0
      ? t('sellers-none')
      : row.sellers
          .map(
            (seller) => seller.storeName?.trim() || t('unnamed', { id: shortId(seller.sellerId) }),
          )
          .join(', ');

  const optional = (column: OptionalColumn, row: DisputeListRow): ReactNode => {
    switch (column) {
      case 'money':
        // Nothing moved: a dash, as on the phone card.
        return row.moneyState === 'none' ? '-' : <MoneyStateBadge state={row.moneyState} />;
      case 'reason':
        return <span className="block min-w-40 whitespace-normal">{reasonText(row.reason)}</span>;
      case 'evidence-due':
        return <EvidenceDueText iso={row.evidenceDueBy} zone={zone} now={now} />;
      case 'stripe-status':
        return (STATUSES as readonly string[]).includes(row.status)
          ? tl(`filter.status.${row.status as (typeof STATUSES)[number]}`)
          : row.status;
      case 'updated':
        return <TimeCell at={row.updatedAt} zone={zone} />;
      case 'seller-ids':
        return (
          <span className="flex flex-wrap gap-x-2">
            {row.sellers.map((seller) => (
              <ShortIdCell key={seller.sellerId} id={seller.sellerId} />
            ))}
          </span>
        );
    }
  };

  const defs: SuperColumn<DisputeListRow>[] = [
    {
      id: 'case',
      header: tl('col.case'),
      primary: true,
      cell: (row) => (
        <a
          className="font-medium text-link underline lg:whitespace-nowrap"
          href={`/disputes/${encodeURIComponent(row.disputeId)}`}
          title={row.orderId}
        >
          {t('case-ref', { id: shortId(row.orderId) })}
        </a>
      ),
    },
    {
      id: 'stage',
      header: tl('col.stage'),
      corner: true,
      cell: (row) => <BucketBadge bucket={row.bucket} />,
    },
    {
      id: 'sellers',
      header: tl('col.sellers'),
      headClassName: 'min-w-40',
      cell: (row) => <span className="wrap-anywhere">{sellers(row)}</span>,
    },
    {
      id: 'amount',
      header: tl('col.amount'),
      numeric: true,
      cell: (row) => (
        <span className="font-medium tabular-nums">
          {formatMinor(row.amount.amountMinor, row.amount.currency, locale)}
        </span>
      ),
    },
    {
      id: 'opened',
      header: tl('col.opened'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.openedAt} zone={zone} />,
    },
    ...columns.map((column): SuperColumn<DisputeListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<DisputeListRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.disputeId}
      rowName={(row) => tl('row-name', { id: shortId(row.orderId), sellers: sellers(row) })}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: tl('select.page'),
          pageShort: tl('select.page-short'),
          row: (name) => tl('select.row', { name }),
        },
      }}
      actions={{
        header: tl('col.actions'),
        label: (name) => tl('actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={defs.length > 7 ? 'lg:min-w-360' : 'lg:min-w-300'}
    />
  );
}
