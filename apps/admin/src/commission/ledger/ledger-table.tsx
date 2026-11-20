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
import { formatMinor } from '../../shipping/money.ts';
import { percentOf, type LedgerKind } from '../types.ts';
import type { OptionalColumn } from './ledger-columns.ts';
import type { LedgerListRow } from './ledger-list-types.ts';

const TONE: Readonly<Record<LedgerKind, BadgeTone>> = {
  sale: 'success',
  shipping: 'info',
  commission: 'attention',
  'refund-sale': 'critical',
  'refund-shipping': 'critical',
  'refund-commission': 'info',
  'dispute-debit': 'critical',
  'dispute-reinstate': 'success',
  'cashback-seller': 'attention',
};

/** An id as a short code; the full id is the tooltip and what a copy takes. */
function IdCell({ id }: { readonly id: string }) {
  return (
    <code className="font-mono text-sm whitespace-nowrap" title={id}>
      {shortId(id)}
    </code>
  );
}

/**
 * The ledger rows of one page, from one column definition (`SuperTable`): a box to select the
 * row, the kind, the amount (a debit with a minus), when it was recorded and the order, then the
 * optional columns the admin chose, and the row Actions menu last. From 1024 px a table; below it
 * each row is a card with labelled lines. No button stands in a row: Open order is in the menu.
 */
export function LedgerTable({
  rows,
  columns,
  zone,
  currency,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly LedgerListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly currency: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: LedgerListRow) => readonly MenuItem[];
}) {
  const tl = useTranslations('commission.ledger.list');
  const tk = useTranslations('commission.ledger.kind');
  const locale = useLocale();
  const none = tl('none');
  const money = (amount: string) => formatMinor(amount, currency, locale);

  const optional = (column: OptionalColumn, row: LedgerListRow): ReactNode => {
    switch (column) {
      case 'occurred':
        return <TimeCell at={row.occurredAt} zone={zone} />;
      case 'seller-order':
        return <IdCell id={row.sellerOrderId} />;
      case 'order-line':
        return row.orderLineId === null ? none : <IdCell id={row.orderLineId} />;
      case 'rate':
        return row.rateBps === null ? none : `${percentOf(row.rateBps, locale)}%`;
      case 'base':
        return row.baseAmount === null ? (
          none
        ) : (
          <span className="tabular-nums">{money(row.baseAmount)}</span>
        );
      case 'source':
        return row.sourceId === null ? none : <IdCell id={row.sourceId} />;
      case 'entry':
        return <IdCell id={row.entryId} />;
    }
  };

  const kindOf = (row: LedgerListRow): ReactNode => {
    const known = row.kind in TONE;
    return (
      <Badge tone={known ? TONE[row.kind] : 'neutral'}>
        {known ? tk(row.kind) : tl('kind-unknown')}
      </Badge>
    );
  };

  const defs: SuperColumn<LedgerListRow>[] = [
    { id: 'kind', header: tl('col.kind'), primary: true, cell: kindOf },
    {
      id: 'amount',
      header: tl('col.amount'),
      numeric: true,
      skeleton: 'number',
      cell: (row) => (
        <span className="font-medium tabular-nums">
          {row.direction === 'debit' ? '−' : ''}
          {money(row.amount)}
        </span>
      ),
    },
    {
      id: 'recorded',
      header: tl('col.recorded'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.recordedAt} zone={zone} />,
    },
    { id: 'order', header: tl('col.order'), cell: (row) => <IdCell id={row.orderId} /> },
    ...columns.map((column): SuperColumn<LedgerListRow> => ({
      id: column,
      header: tl(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<LedgerListRow>
      caption={tl('caption')}
      rows={rows}
      rowId={(row) => row.entryId}
      rowName={(row) => tl('row-name', { id: shortId(row.entryId) })}
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
      minWidthClass={defs.length > 5 ? 'lg:min-w-240' : 'lg:min-w-160'}
    />
  );
}
