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
import { shortInstant } from '../../catalog/format.ts';
import { shortId } from '../../orders/status.ts';
import { formatMinor } from '../../price/money.ts';
import {
  BLOCK_REASONS,
  PAYOUT_STATUSES,
  type OwnPayoutRow,
  type PayoutMoney,
} from '../payout-types.ts';
import type { OptionalColumn } from './payouts-columns.ts';

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  scheduled: 'neutral',
  'awaiting-approval': 'attention',
  'on-its-way': 'info',
  paid: 'success',
  'not-sent': 'neutral',
  failed: 'critical',
  settled: 'neutral',
};

/** The status as the panel knows it: one it does not know is "unknown", never a guess. */
export const statusOf = (row: OwnPayoutRow): string =>
  (PAYOUT_STATUSES as readonly string[]).includes(row.status) ? row.status : 'unknown';

/**
 * The payouts of one page, from one column definition (`SuperTable`): a box to select the row,
 * the payout day (the card's title on a phone) with the status beside it, then the columns the
 * seller chose, and the row Actions menu last. From 1024 px a table; below it each payout is a
 * card with labelled lines. Dates are on the store's clock; money is in each payout's currency.
 */
export function PayoutsTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly OwnPayoutRow[];
  readonly columns: readonly OptionalColumn[];
  /** The store's IANA zone. */
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: OwnPayoutRow) => readonly MenuItem[];
}) {
  const t = useTranslations('payouts.list');
  const th = useTranslations('payouts.history');
  const tn = useTranslations('payouts.next');
  const locale = useLocale();
  const money = (value: PayoutMoney) => formatMinor(value.amountMinor, value.currency, locale);
  const when = (iso: string) => <time dateTime={iso}>{shortInstant(iso, locale, zone)}</time>;

  const note = (row: OwnPayoutRow): string => {
    const status = statusOf(row);
    const reason =
      row.reason !== null && (BLOCK_REASONS as readonly string[]).includes(row.reason)
        ? row.reason
        : null;
    if (status === 'failed') return th('failed-note');
    if (status === 'not-sent') {
      return reason === null
        ? th('not-sent-note')
        : tn(`block-short.${reason}` as 'block-short.below-minimum');
    }
    if (status === 'settled') return th('settled-note', { amount: money(row.netted) });
    if (status === 'awaiting-approval') return th('first-note');
    return '-';
  };

  const content = (column: OptionalColumn, row: OwnPayoutRow): ReactNode => {
    switch (column) {
      case 'note':
        return note(row);
      case 'amount': {
        const kept =
          BigInt(row.netted.amountMinor) > 0n && statusOf(row) !== 'settled'
            ? th('kept', { amount: money(row.netted) })
            : null;
        return (
          <span className="flex flex-col lg:items-end">
            <span className="font-medium">{money(row.transfer)}</span>
            {kept === null ? null : (
              <span className="text-xs font-normal text-fg-muted">{kept}</span>
            )}
          </span>
        );
      }
      case 'gross':
        return money(row.gross);
      case 'netted':
        return money(row.netted);
      case 'created':
        return when(row.createdAt);
      case 'updated':
        return when(row.updatedAt);
      case 'payoutId':
        return (
          <span title={row.payoutId} className="font-mono text-sm">
            {shortId(row.payoutId)}
          </span>
        );
    }
  };

  const defs: SuperColumn<OwnPayoutRow>[] = [
    {
      id: 'payoutOn',
      header: t('col.payoutOn'),
      primary: true,
      skeleton: 'date',
      cell: (row) => <span className="font-medium">{when(row.slotAt)}</span>,
    },
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (row) => (
        <Badge tone={STATUS_TONE[statusOf(row)] ?? 'neutral'}>
          {th(`status.${statusOf(row)}` as 'status.paid')}
        </Badge>
      ),
    },
    ...columns.map((column): SuperColumn<OwnPayoutRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: column === 'amount' || column === 'gross' || column === 'netted',
      ...(column === 'created' || column === 'updated' ? { skeleton: 'date' as const } : {}),
      cell: (row) => content(column, row),
    })),
  ];

  return (
    <SuperTable<OwnPayoutRow>
      caption={th('title')}
      rows={rows}
      rowId={(row) => row.payoutId}
      rowName={(row) => t('row-name', { id: shortId(row.payoutId) })}
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
