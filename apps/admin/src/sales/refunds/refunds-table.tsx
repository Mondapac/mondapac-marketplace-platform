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
import { known } from '../../sellers/format.ts';
import { shortId } from '../../shared/short-id.ts';
import { EmptyWord, MoneyCell, OrderLink, ShortIdCell, StoreCell, TimeCell } from '../cells.tsx';
import { CustomerCell } from '../customer-cell.tsx';
import { MONEY_COLUMNS, type OptionalColumn } from './refunds-columns.ts';
import {
  ACTORS,
  LOSS_BEARERS,
  LOSS_REASONS,
  REASONS,
  STATES,
  type RefundRow,
} from './refunds-types.ts';

const STATE_TONE: Record<string, BadgeTone> = {
  pending: 'attention',
  succeeded: 'success',
  failed: 'critical',
};

/** The state as a badge: the words of the order page (`orders.refund-state.*`). */
function StateCell({ row }: { readonly row: RefundRow }) {
  const to = useTranslations('orders.refund-state');
  const state = known(row.state, STATES);
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{to(state)}</Badge>;
}

/** Who bears the loss; for the platform, the reason under it as a muted line. */
function LossCell({ row }: { readonly row: RefundRow }) {
  const t = useTranslations('refunds');
  const to = useTranslations('orders.actions');
  const bearer = known(row.lossBearer, LOSS_BEARERS);
  if (bearer === 'unknown') return <EmptyWord>{t('unknown')}</EmptyWord>;
  const code = row.lossReasonCode === null ? null : known(row.lossReasonCode, LOSS_REASONS);
  // A code this panel does not know reads "Other", as the order page does.
  const reason =
    bearer === 'platform' && code !== null ? (code === 'unknown' ? 'other' : code) : null;
  return (
    <div className="min-w-0">
      <div>{to(`loss-bearer-option.${bearer}`)}</div>
      {reason === null ? null : (
        <div className="text-sm text-fg-muted">{to(`loss-reason-option.${reason}`)}</div>
      )}
    </div>
  );
}

/**
 * When the refund went into the seller ledger. A succeeded refund not recorded yet is "Waiting"
 * (a badge); one Stripe has not answered is "Not yet"; a refused one never reaches the ledger.
 */
function LedgerCell({ row, zone }: { readonly row: RefundRow; readonly zone: string }) {
  const t = useTranslations('refunds');
  if (row.ledgerRecordedAt !== null) return <TimeCell at={row.ledgerRecordedAt} zone={zone} />;
  if (row.state === 'succeeded') return <Badge tone="attention">{t('ledger.waiting')}</Badge>;
  if (row.state === 'pending') return <EmptyWord>{t('not-yet')}</EmptyWord>;
  return <EmptyWord>{t('none')}</EmptyWord>;
}

/**
 * The refunds of one page, from one column definition (`SuperTable`): a box to select the row,
 * the order reference, the state, then the columns the admin chose in their order, and the row
 * Actions menu last. From 1024 px a table; below it each refund is a card with labelled lines
 * (the reference as its title, the state in its corner). Times are in `zone`, which the page
 * names once; money is in each row's own currency.
 */
export function RefundsTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly RefundRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /** The first load: this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: RefundRow) => readonly MenuItem[];
}) {
  const t = useTranslations('refunds');
  const to = useTranslations('orders.actions.refund-reason');
  const content = (column: OptionalColumn, row: RefundRow): ReactNode => {
    switch (column) {
      case 'amount':
        return <MoneyCell money={row.gross} strong />;
      case 'reason':
        return to(known(row.reason, REASONS));
      case 'actor':
        return t(`actor.${known(row.actor, ACTORS)}`);
      case 'store':
        return <StoreCell storeName={row.storeName} sellerId={row.sellerId} />;
      case 'customer':
        return <CustomerCell customer={row.customer} accountId={row.accountId} />;
      case 'requested':
        return <TimeCell at={row.requestedAt} zone={zone} />;
      case 'lossBearer':
        return <LossCell row={row} />;
      case 'ledger':
        return <LedgerCell row={row} zone={zone} />;
      case 'tax':
        return <MoneyCell money={row.tax} />;
      case 'shipping':
        return <MoneyCell money={row.shippingGross} zeroWord={t('none')} />;
      case 'settled':
        return <TimeCell at={row.settledAt} zone={zone} empty={t('not-yet')} />;
      case 'stripeRefundId': {
        const id = row.stripeRefundId?.trim() ?? '';
        if (id === '') {
          return (
            <EmptyWord>{row.state === 'pending' ? t('stripe-not-made') : t('none')}</EmptyWord>
          );
        }
        return (
          <span className="[overflow-wrap:anywhere]" title={id}>
            {id}
          </span>
        );
      }
      case 'creditNote':
        return row.creditNoteId === null ? (
          <EmptyWord>{t('none')}</EmptyWord>
        ) : (
          <ShortIdCell id={row.creditNoteId} />
        );
      case 'refundId':
        return <ShortIdCell id={row.refundId} />;
      case 'sellerOrderId':
        return <ShortIdCell id={row.sellerOrderId} />;
    }
  };

  const defs: SuperColumn<RefundRow>[] = [
    {
      id: 'order',
      header: t('col.order'),
      primary: true,
      cell: (row) => <OrderLink orderId={row.orderId} />,
    },
    {
      id: 'state',
      header: t('col.state'),
      corner: true,
      cell: (row) => <StateCell row={row} />,
    },
    ...columns.map((column): SuperColumn<RefundRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: MONEY_COLUMNS.includes(column),
      ...(column === 'requested' || column === 'settled' || column === 'ledger'
        ? { skeleton: 'date' as const }
        : {}),
      cell: (row) => content(column, row),
    })),
  ];

  return (
    <SuperTable<RefundRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.refundId}
      rowName={(row) => t('row-name', { id: shortId(row.orderId) })}
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
        header: t('actions.header'),
        label: (name) => t('actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={
        columns.length > 9
          ? 'lg:min-w-480'
          : columns.length > 5
            ? 'lg:min-w-360'
            : columns.length > 3
              ? 'lg:min-w-300'
              : 'lg:min-w-240'
      }
    />
  );
}
