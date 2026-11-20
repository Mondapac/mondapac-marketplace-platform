'use client';

import {
  Badge,
  SuperTable,
  type BadgeTone,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { TimeCell } from '../../sales/cells.tsx';
import { shortId } from '../../shared/short-id.ts';
import { wordFor } from '../labels.ts';
import { formatMinor } from '../money.ts';
import type { OptionalColumn } from './credit-requests-columns.ts';
import { STATUSES, type CreditListRow } from './credit-requests-list-types.ts';

const STATUS_TONE: Readonly<Record<(typeof STATUSES)[number], BadgeTone>> = {
  granted: 'success',
  pending: 'attention',
  approved: 'success',
  rejected: 'critical',
  expired: 'neutral',
};

/**
 * The credit requests of one page, from one column definition (`SuperTable`): a box to select the
 * row, the customer, the amount, the status and when it was requested, then the optional columns
 * the admin chose, and the row Actions menu last. From 1024 px a table; below it each request is
 * a card with labelled lines (the customer as its title, the status in its corner). No button
 * stands in a row: Details, Approve and Reject are in the Actions menu.
 */
export function CreditRequestsTable({
  rows,
  columns,
  zone,
  accountId,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly CreditListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  /** The signed-in admin: their own requests read "You". */
  readonly accountId: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: CreditListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('wallet');
  const tl = useTranslations('wallet.list');
  const locale = useLocale();
  const none = tl('none');
  const person = (id: string | null): ReactNode =>
    id === null ? none : <span title={id}>{id === accountId ? tl('you') : shortId(id)}</span>;

  const optional = (column: OptionalColumn, row: CreditListRow): ReactNode => {
    switch (column) {
      case 'reason':
        return wordFor(t, 'credit.reason', row.reasonCode);
      case 'requested-by':
        return person(row.requestedBy);
      case 'until':
        return (
          <TimeCell
            at={row.status === 'pending' ? row.expiresAt : row.decidedAt}
            zone={zone}
            empty={none}
          />
        );
      case 'approval-reason':
        return row.approvalReason === null
          ? none
          : wordFor(t, 'result.approval-reason', row.approvalReason);
      case 'decided-by':
        return person(row.decidedBy);
      case 'decision-reason':
        return row.decisionReason === null
          ? none
          : wordFor(t, 'list.reject-reason', row.decisionReason);
      case 'note':
        return row.note === null ? (
          none
        ) : (
          <span className="whitespace-pre-line wrap-anywhere">{row.note}</span>
        );
      case 'journal':
        return row.journalId === null ? (
          none
        ) : (
          <span title={row.journalId}>{shortId(row.journalId)}</span>
        );
    }
  };

  const status = (row: CreditListRow): ReactNode => {
    const known = (STATUSES as readonly string[]).includes(row.status);
    return (
      <Badge tone={known ? STATUS_TONE[row.status] : 'neutral'}>
        {known ? tl(`status.${row.status}`) : row.status}
      </Badge>
    );
  };

  const defs: SuperColumn<CreditListRow>[] = [
    {
      id: 'customer',
      header: tl('col.customer'),
      primary: true,
      cell: (row) => (
        <a
          className="font-semibold text-link underline lg:whitespace-nowrap"
          href={`/wallet/credits?customer=${encodeURIComponent(row.customerAccountId)}`}
          title={row.customerAccountId}
        >
          {shortId(row.customerAccountId)}
        </a>
      ),
    },
    {
      id: 'amount',
      header: tl('col.amount'),
      numeric: true,
      cell: (row) => (
        <span className="font-medium tabular-nums">
          {formatMinor(row.amount, row.currency, locale)}
        </span>
      ),
    },
    { id: 'status', header: tl('col.status'), corner: true, cell: status },
    {
      id: 'requested',
      header: tl('col.requested'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.requestedAt} zone={zone} />,
    },
    ...columns.map((column): SuperColumn<CreditListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<CreditListRow>
      caption={tl('caption')}
      rows={rows}
      rowId={(row) => row.id}
      rowName={(row) =>
        tl('row-name', {
          customer: shortId(row.customerAccountId),
          amount: formatMinor(row.amount, row.currency, locale),
        })
      }
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
