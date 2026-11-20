'use client';

import { ActionMenu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { useSalesExport, type ExportSelection } from '../../sales/sales-export.tsx';
import { idSearchRoute } from '../../shared/id-search.ts';
import { exportColumns, type OptionalColumn } from './ledger-columns.ts';
import { FIXED_SORT, SELECTION_MAX, type Query } from './ledger-list-types.ts';
import { selectorParams } from './ledger-query.ts';

/**
 * The query of the export. Ticked rows go by id alone (the API ignores a filter or a sort beside
 * `ids`, so none is sent); "Select all matching" sends the list's selector keys and its sort.
 * `columns` are the optional columns shown, in the shown order (mapped to the API's own ids). The
 * route takes no `zone`: the file writes the instants as they are.
 */
export function exportParams(input: {
  readonly query: Query;
  readonly paging: ListPagingMode;
  readonly zone: string;
  readonly currency: string;
  readonly format: string;
  readonly columns: readonly OptionalColumn[];
  readonly selection: ExportSelection;
  readonly now?: Date;
}): string {
  const { selection, query } = input;
  const params = new URLSearchParams();
  if (selection.allMatching) {
    const route = idSearchRoute(query.q);
    for (const [key, value] of selectorParams(
      query,
      {
        paging: input.paging,
        zone: input.zone,
        currency: input.currency,
        now: input.now ?? new Date(),
      },
      route.kind === 'id' ? route.value : '',
    )) {
      params.set(key, value);
    }
    // Previous and next lists the newest record first only: the file keeps the order on screen.
    params.set('sort', input.paging === 'pages' ? query.sort : FIXED_SORT);
    params.set('direction', input.paging === 'pages' ? query.direction : 'desc');
  } else {
    if (selection.ids.length === 0) throw new Error('export.no-rows-selected');
    params.set('ids', selection.ids.slice(0, SELECTION_MAX).join(','));
  }
  params.set('format', input.format);
  const columns = exportColumns(input.columns);
  if (columns.length > 0) params.set('columns', columns.join(','));
  return params.toString();
}

/**
 * The Bulk action menu of the ledger list. Nothing is changed in bulk, so the one item is Export.
 * The button is disabled until a row is selected.
 */
export function LedgerBulk({
  sellerId,
  selection,
  query,
  paging,
  zone,
  currency,
  columns,
  now,
}: {
  readonly sellerId: string;
  readonly selection: ExportSelection;
  readonly query: Query;
  readonly paging: ListPagingMode;
  readonly zone: string;
  readonly currency: string;
  readonly columns: readonly OptionalColumn[];
  /** When the rows on show were read; the date presets of "all matching" use this clock. */
  readonly now?: Date;
}) {
  const t = useTranslations('commission.ledger.list.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const { item, dialog, busy } = useSalesExport({
    path: `commission-payouts/admin/sellers/${encodeURIComponent(sellerId)}/ledger/export`,
    fallbackName: 'seller-ledger',
    listQuery: '',
    columns,
    zone,
    selection,
    buildQuery: (format) =>
      exportParams({ query, paging, zone, currency, format, columns, selection, now }),
  });
  return (
    <>
      <ActionMenu
        label={t('button')}
        title={
          selection.allMatching && selection.total === null
            ? t('all-open')
            : t('selected', { count })
        }
        items={[item]}
        disabled={!selected || busy}
      />
      {dialog}
    </>
  );
}
