'use client';

import {
  Badge,
  Icon,
  SuperTable,
  type BadgeTone,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstantInZone } from '../../shared/format.ts';
import { known } from '../../sellers/format.ts';
import { shortId } from '../../shared/short-id.ts';
import { FallbackId } from '../../orders/fallback-id.tsx';
import { EmptyWord, MoneyCell, OrderLink, StoreCell, TimeCell } from '../cells.tsx';
import { CustomerCell } from '../customer-cell.tsx';
import { MONEY_COLUMNS, type OptionalColumn } from './shipments-columns.ts';
import {
  DELIVERY_ATTENTIONS,
  CARRIER_PROGRESS,
  DELIVERY_METHODS,
  STAGES,
  type ShipmentRow,
} from './shipments-types.ts';
import { windowParts } from './shipments-window.ts';

const STAGE_TONE: Record<string, BadgeTone> = {
  'to-prepare': 'attention',
  ready: 'info',
  shipped: 'info',
  delivered: 'success',
  refunded: 'neutral',
};

/** The stage as a badge, and under it the delivery problem when there is one. */
function StageCell({ row }: { readonly row: ShipmentRow }) {
  const t = useTranslations('shipments');
  const to = useTranslations('orders.detail.attention');
  const stage = known(row.stage, STAGES);
  const problem = row.deliveryAttention;
  const code = problem === null ? null : known(problem, DELIVERY_ATTENTIONS);
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge tone={STAGE_TONE[stage] ?? 'neutral'}>{t(`stage.${stage}`)}</Badge>
      {code === null ? null : (
        <span title={to(code === 'unknown' ? 'other' : code)}>
          <Badge tone="critical">
            <Icon name="alert-triangle" />
            {t(`problem.${code}`)}
          </Badge>
        </span>
      )}
    </div>
  );
}

function DeliveryCell({ row, zone }: { readonly row: ShipmentRow; readonly zone: string }) {
  const t = useTranslations('shipments');
  const to = useTranslations('orders');
  const locale = useLocale();
  const method = known(row.deliveryMethod, DELIVERY_METHODS);
  const window =
    method === 'scheduled' && row.deliveryWindow !== null
      ? windowParts(row.deliveryWindow, locale, zone)
      : null;
  return (
    <div className="min-w-0">
      <div>{to(`delivery-method.${method}`)}</div>
      {window === null ? null : (
        <div className="text-sm whitespace-nowrap text-fg-muted">
          {t('window', { start: window.start, end: window.end })}
        </div>
      )}
    </div>
  );
}

/** Carrier, the tracking reference under it; the words for none depend on how it travels. */
function CarrierCell({ row }: { readonly row: ShipmentRow }) {
  const t = useTranslations('shipments');
  const carrier = row.carrier?.trim() ?? '';
  const tracking = row.trackingRef?.trim() ?? '';
  if (carrier === '' && tracking === '') {
    if (row.deliveryMethod === 'pickup') return <EmptyWord>{t('carrier.pickup')}</EmptyWord>;
    // Nothing was shipped (a row refunded before shipping included): "Not shipped yet", whatever
    // its fulfilment value says. A shipped or delivered row without a carrier was not recorded.
    const neverShipped =
      row.shippedAt === null && row.stage !== 'shipped' && row.stage !== 'delivered';
    return <EmptyWord>{neverShipped ? t('carrier.not-shipped') : t('not-recorded')}</EmptyWord>;
  }
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      {carrier === '' ? null : <div title={carrier}>{carrier}</div>}
      {tracking === '' ? null : (
        <div className="text-sm text-fg-muted" title={tracking}>
          {tracking}
        </div>
      )}
    </div>
  );
}

const PROGRESS_TONE: Record<string, BadgeTone> = {
  booked: 'neutral',
  'picked-up': 'info',
  delivered: 'success',
  exception: 'critical',
  cancelled: 'neutral',
};

/**
 * What the carrier booking reports: the progress as a badge, then (each only when there is
 * something to say) the proof marker, the carrier's own code, when it was recorded and the fleet
 * when it differs from the row's. Advisory: it can disagree with the Stage, and both show as given.
 */
function CarrierProgressCell({
  row,
  available,
  zone,
}: {
  readonly row: ShipmentRow;
  readonly available: boolean;
  readonly zone: string;
}) {
  const t = useTranslations('shipments.carrier-progress');
  const locale = useLocale();
  if (!available) {
    return (
      <EmptyWord>
        <span title={t('not-available-title')}>{t('not-available')}</span>
      </EmptyWord>
    );
  }
  const progress = row.carrierProgress;
  if (progress === null) {
    return (
      <>
        <EmptyWord>
          <span aria-hidden="true">{'\u2014'}</span>
        </EmptyWord>
        <span className="sr-only">{t('none-sr')}</span>
      </>
    );
  }
  const state = known(progress.progress, CARRIER_PROGRESS);
  const status = progress.carrierStatus?.trim() ?? '';
  const fleet = progress.fleet.trim();
  const showFleet = fleet !== '' && fleet !== (row.fleet?.trim() ?? null);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <span title={t('advisory')}>
        <Badge tone={PROGRESS_TONE[state] ?? 'neutral'}>
          {state === 'exception' ? <Icon name="alert-triangle" /> : null}
          {t(`label.${state}`)}
        </Badge>
      </span>
      {progress.proofOfDelivery ? (
        <span className="text-sm text-fg-muted">
          <Icon name="check" /> {t('proof')}
        </span>
      ) : null}
      {status === '' ? null : (
        <span className="text-sm text-fg-muted [overflow-wrap:anywhere]" title={status}>
          {status}
        </span>
      )}
      <span className="text-sm whitespace-nowrap text-fg-muted">
        {t('updated', { time: shortInstantInZone(progress.updatedAt, locale, zone, true) })}
      </span>
      {showFleet ? (
        <span className="text-sm text-fg-muted [overflow-wrap:anywhere]" title={fleet}>
          {t('booked-on', { fleet })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The shipments of one page, from one column definition (`SuperTable`): a box to select the row,
 * the order reference, the stage, then the columns the admin chose in their order, and the row
 * Actions menu last. From 1024 px a table; below it each shipment is a card with labelled lines
 * (the reference as its title, the stage in its corner). Times are in `zone`, the viewer's own zone (named in the Help
 * panel and the account menu, not on the page); money is in each row's own currency.
 */
export function ShipmentsTable({
  rows,
  columns,
  zone,
  carrierProgressAvailable,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly ShipmentRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  /** False when the carrier progress of the page could not be loaded. */
  readonly carrierProgressAvailable: boolean;
  readonly selection: RowSelectionState;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /** The first load: this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: ShipmentRow) => readonly MenuItem[];
}) {
  const t = useTranslations('shipments');
  const content = (column: OptionalColumn, row: ShipmentRow): ReactNode => {
    switch (column) {
      case 'store':
        return <StoreCell storeName={row.storeName} sellerId={row.sellerId} />;
      case 'customer':
        return <CustomerCell customer={row.customer} accountId={row.accountId} />;
      case 'paid':
        return <TimeCell at={row.paidAt} zone={zone} />;
      case 'delivery':
        return <DeliveryCell row={row} zone={zone} />;
      case 'carrier':
        return <CarrierCell row={row} />;
      case 'carrier-progress':
        return <CarrierProgressCell row={row} available={carrierProgressAvailable} zone={zone} />;
      case 'total':
        return <MoneyCell money={row.total} strong />;
      case 'ready':
        return <TimeCell at={row.readyAt} zone={zone} empty={t('not-yet')} />;
      case 'shipped':
        return <TimeCell at={row.shippedAt} zone={zone} empty={t('not-yet')} />;
      case 'delivered':
        return <TimeCell at={row.deliveredAt} zone={zone} empty={t('not-yet')} />;
      case 'fleet':
        return row.fleet === null || row.fleet === '' ? (
          <EmptyWord>{t('not-recorded')}</EmptyWord>
        ) : (
          <span className="break-words" title={row.fleet}>
            {row.fleet}
          </span>
        );
      case 'fee':
        return <MoneyCell money={row.shipping} />;
      case 'refunded':
        return <MoneyCell money={row.refunded} zeroWord={t('none')} />;
      case 'seller-order':
        return <FallbackId id={row.sellerOrderId} />;
    }
  };

  const defs: SuperColumn<ShipmentRow>[] = [
    {
      id: 'order',
      header: t('col.order'),
      primary: true,
      cell: (row) => <OrderLink orderId={row.orderId} />,
    },
    {
      id: 'stage',
      header: t('col.stage'),
      corner: true,
      cell: (row) => <StageCell row={row} />,
    },
    ...columns.map((column): SuperColumn<ShipmentRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: MONEY_COLUMNS.includes(column),
      ...(column === 'paid' || column === 'ready' || column === 'shipped' || column === 'delivered'
        ? { skeleton: 'date' as const }
        : {}),
      cell: (row) => content(column, row),
    })),
  ];

  return (
    <SuperTable<ShipmentRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.sellerOrderId}
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
