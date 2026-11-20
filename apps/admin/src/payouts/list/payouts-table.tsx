'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { EmptyWord, ShortIdCell, TimeCell } from '../../sales/cells.tsx';
import { shortId } from '../../shared/short-id.ts';
import { formatMinor } from '../../wallet/money.ts';
import { StateBadge } from '../state-badge.tsx';
import type { PayoutMoney } from '../types.ts';
import type { OptionalColumn } from './payouts-columns.ts';
import type { PayoutListRow } from './payouts-list-types.ts';

/** The outcome codes the detail page explains; any other one shows as the code itself. */
const KNOWN_OUTCOMES = [
  'payout-unwound',
  'transfer-failed',
  'transfer-refused',
  'voided-hold',
  'voided-amount-changed',
  'voided-access',
  'voided-account-not-ready',
  'voided-second-factor',
] as const;

/**
 * The payouts of one page, from one column definition (`SuperTable`): a box to select the row, the
 * payout, its state, the store, the transfer and when it was created, then the optional columns
 * the admin chose, and the row Actions menu last. From 1024 px a table; below it each payout is a
 * card with labelled lines (the payout as its title, the state in its corner). No button stands in
 * a row: approving and holds are in the Actions menu.
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
  readonly rows: readonly PayoutListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: PayoutListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('payouts');
  const tl = useTranslations('payouts.list');
  const locale = useLocale();
  const money = (value: PayoutMoney) => formatMinor(value.amountMinor, value.currency, locale);
  const store = (row: PayoutListRow) =>
    row.storeName?.trim() || t('unnamed', { id: shortId(row.sellerId) });

  const optional = (column: OptionalColumn, row: PayoutListRow): ReactNode => {
    switch (column) {
      case 'gross':
        return <span className="tabular-nums">{money(row.gross)}</span>;
      case 'netted':
        return <span className="tabular-nums">{money(row.netted)}</span>;
      case 'approval-mode':
        return tl(`filter.mode.${row.approvalMode === 'MANUAL' ? 'MANUAL' : 'AUTO'}`);
      case 'approval-reason':
        return row.approvalMode === 'AUTO' || row.approvalReason === null
          ? t('why.auto')
          : t(`why.${row.approvalReason}`);
      case 'slot':
        return <TimeCell at={row.slotAt} zone={zone} />;
      case 'state-changed':
        return <TimeCell at={row.stateChangedAt} zone={zone} />;
      case 'outcome':
        if (row.outcomeCode === null) return <EmptyWord>{tl('no-outcome')}</EmptyWord>;
        return (KNOWN_OUTCOMES as readonly string[]).includes(row.outcomeCode)
          ? t(`outcome.${row.outcomeCode as (typeof KNOWN_OUTCOMES)[number]}`)
          : row.outcomeCode;
      case 'seller-id':
        return <ShortIdCell id={row.sellerId} />;
    }
  };

  const defs: SuperColumn<PayoutListRow>[] = [
    {
      id: 'payout',
      header: tl('col.payout'),
      primary: true,
      cell: (row) => (
        <a
          className="font-medium text-link underline lg:whitespace-nowrap"
          href={`/payouts/${encodeURIComponent(row.payoutId)}`}
          title={row.payoutId}
        >
          {t('ref', { id: shortId(row.payoutId) })}
        </a>
      ),
    },
    {
      id: 'state',
      header: tl('col.state'),
      corner: true,
      cell: (row) => <StateBadge state={row.state} />,
    },
    {
      id: 'store',
      header: tl('col.store'),
      headClassName: 'min-w-40',
      cell: (row) => (
        <a
          className="wrap-anywhere text-link underline"
          href={`/sellers/${encodeURIComponent(row.sellerId)}`}
          title={row.sellerId}
        >
          {store(row)}
        </a>
      ),
    },
    {
      id: 'transfer',
      header: tl('col.transfer'),
      numeric: true,
      cell: (row) => <span className="font-medium tabular-nums">{money(row.transfer)}</span>,
    },
    {
      id: 'created',
      header: tl('col.created'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.createdAt} zone={zone} />,
    },
    ...columns.map((column): SuperColumn<PayoutListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      ...(column === 'gross' || column === 'netted' ? { numeric: true } : {}),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<PayoutListRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.payoutId}
      rowName={(row) => tl('row-name', { id: shortId(row.payoutId), store: store(row) })}
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
