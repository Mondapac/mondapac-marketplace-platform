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
import { HOLD_REASONS, RELEASE_REASONS } from '../seller-types.ts';
import type { OptionalColumn } from './holds-columns.ts';
import type { HoldListRow } from './holds-list-types.ts';

const TONE: Readonly<Record<string, BadgeTone>> = {
  'seller-suspended': 'critical',
  dispute: 'critical',
  'refund-pending': 'neutral',
  'admin-review': 'neutral',
  'bank-change': 'attention',
};

/** What a hold covers: the whole seller, or one seller order (its full id is the tooltip). */
function CoversText({ hold }: { readonly hold: HoldListRow }) {
  const t = useTranslations('payouts.seller.holds');
  return (
    <span title={hold.sellerOrderId ?? undefined}>
      {hold.sellerOrderId === null
        ? t('whole-seller')
        : t('order', { id: shortId(hold.sellerOrderId) })}
    </span>
  );
}

/**
 * The holds of one page, from one column definition (`SuperTable`): a box to select the row, what
 * it covers, the reason, when it was placed and its status, then the optional columns the admin
 * chose, and the row Actions menu last. From 1024 px a table; below it each hold is a card with
 * labelled lines. No button stands in a row: Release hold… is in the Actions menu.
 */
export function HoldsTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly HoldListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: HoldListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('payouts.seller.holds');
  const tl = useTranslations('payouts.seller.holds.list');
  const none = tl('none');

  const reasonLabel = (code: string) =>
    (HOLD_REASONS as readonly string[]).includes(code)
      ? t(`reason.${code}` as 'reason.dispute')
      : t('reason.unknown');
  const releaseLabel = (code: string | null) =>
    code === null
      ? none
      : (RELEASE_REASONS as readonly string[]).includes(code)
        ? t(`release.${code}` as 'release.resolved')
        : tl('release-unknown');

  const optional = (column: OptionalColumn, row: HoldListRow): ReactNode => {
    switch (column) {
      case 'origin':
        return t(`origin.${row.origin}`);
      case 'released':
        return <TimeCell at={row.releasedAt} zone={zone} empty={none} />;
      case 'release-reason':
        return releaseLabel(row.releaseReason);
      case 'hold':
        return (
          <code className="font-mono text-sm whitespace-nowrap" title={row.holdId}>
            {shortId(row.holdId)}
          </code>
        );
    }
  };

  const defs: SuperColumn<HoldListRow>[] = [
    {
      id: 'covers',
      header: tl('col.covers'),
      primary: true,
      cell: (row) => <CoversText hold={row} />,
    },
    {
      id: 'reason',
      header: tl('col.reason'),
      corner: true,
      cell: (row) => <Badge tone={TONE[row.reason] ?? 'neutral'}>{reasonLabel(row.reason)}</Badge>,
    },
    {
      id: 'placed',
      header: tl('col.placed'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.placedAt} zone={zone} />,
    },
    {
      id: 'status',
      header: tl('col.status'),
      cell: (row) =>
        row.active ? (
          <Badge tone="attention">{t('active')}</Badge>
        ) : (
          <Badge tone="neutral">{tl('released')}</Badge>
        ),
    },
    ...columns.map((column): SuperColumn<HoldListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<HoldListRow>
      caption={tl('caption')}
      rows={rows}
      rowId={(row) => row.holdId}
      rowName={(row) => tl('row-name', { id: shortId(row.holdId) })}
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
      minWidthClass={defs.length > 6 ? 'lg:min-w-240' : 'lg:min-w-160'}
    />
  );
}
