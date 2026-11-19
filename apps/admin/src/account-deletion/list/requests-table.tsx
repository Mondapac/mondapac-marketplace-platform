'use client';

import {
  Badge,
  SuperTable,
  type BadgeTone,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { TimeCell } from '../../sales/cells.tsx';
import { shortId } from '../../shared/short-id.ts';
import type { OptionalColumn } from './requests-columns.ts';
import { STATUSES, type DeletionListRow } from './requests-list-types.ts';

/** The statuses whose account still exists, so the account id links to the customer. */
const LINKED_STATUSES: readonly string[] = ['pending', 'executing', 'cancelled'];

const STATUS_TONE: Readonly<Record<(typeof STATUSES)[number], BadgeTone>> = {
  pending: 'attention',
  executing: 'info',
  cancelled: 'neutral',
  completed: 'success',
};

/**
 * The deletion requests of one page, from one column definition (`SuperTable`): a box to select
 * the row, the buyer account, the status, when it was requested and when it deletes, then the
 * optional columns the admin chose, and the row Actions menu last. From 1024 px a table; below it
 * each request is a card with labelled lines (the account as its title, the status in its corner).
 * No button stands in a row: Cancel request is in the Actions menu. The API names no buyer, only
 * the account id, so the id links to the buyer (an erased account has no page to open).
 */
export function RequestsTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly DeletionListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: DeletionListRow) => readonly MenuItem[];
}) {
  const tl = useTranslations('account-deletion.list');
  const none = tl('none');

  const optional = (column: OptionalColumn, row: DeletionListRow): ReactNode => {
    switch (column) {
      case 'requested-by':
        return <Badge tone="neutral">{tl(`by.${row.requestedBy}`)}</Badge>;
      case 'cancelled':
        return <TimeCell at={row.cancelledAt} zone={zone} empty={none} />;
      case 'cancel-reason':
        return row.cancelReason === null ? none : tl(`cancel-reason.${row.cancelReason}`);
      case 'completed':
        return <TimeCell at={row.completedAt} zone={zone} empty={none} />;
    }
  };

  const status = (row: DeletionListRow): ReactNode => {
    const known = (STATUSES as readonly string[]).includes(row.status);
    return (
      <Badge tone={known ? STATUS_TONE[row.status as (typeof STATUSES)[number]] : 'neutral'}>
        {known ? tl(`status.${row.status}`) : row.status}
      </Badge>
    );
  };

  const defs: SuperColumn<DeletionListRow>[] = [
    {
      id: 'account',
      header: tl('col.account'),
      primary: true,
      cell: (row) =>
        // Only a status whose account still exists links to it; an erased or unknown one does not.
        !LINKED_STATUSES.includes(row.status) ? (
          <span className="flex flex-col gap-0.5">
            <code className="font-mono text-sm wrap-anywhere select-all">{row.accountId}</code>
            {row.status === 'completed' ? (
              <span className="text-sm text-fg-muted">{tl('erased')}</span>
            ) : null}
          </span>
        ) : (
          <a
            className="font-mono text-sm font-semibold text-link underline wrap-anywhere"
            href={`/customers/${encodeURIComponent(row.accountId)}`}
          >
            {row.accountId}
          </a>
        ),
    },
    { id: 'status', header: tl('col.status'), corner: true, cell: status },
    {
      id: 'requested',
      header: tl('col.requested'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.requestedAt} zone={zone} />,
    },
    {
      id: 'deletes-on',
      header: tl('col.deletes-on'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.scheduledFor} zone={zone} />,
    },
    ...columns.map((column): SuperColumn<DeletionListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<DeletionListRow>
      caption={tl('caption')}
      rows={rows}
      rowId={(row) => row.requestId}
      rowName={(row) => tl('row-name', { account: shortId(row.accountId) })}
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
      minWidthClass={defs.length > 6 ? 'lg:min-w-300' : 'lg:min-w-240'}
    />
  );
}
