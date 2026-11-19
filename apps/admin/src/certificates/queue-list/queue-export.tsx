'use client';

import { ActionMenu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useSalesExport, type ExportSelection } from '../../sales/sales-export.tsx';
import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import type { OptionalColumn } from './queue-columns.ts';
import { selectorParams } from './queue-query.ts';
import { SELECTION_MAX, type Query } from './queue-types.ts';

/**
 * The query of the export. Ticked rows go by id alone (the API refuses a filter or a sort beside
 * `ids`); "Select all matching" sends the list's selector keys and its sort. `columns` are the
 * optional columns shown, in the shown order (the API adds the fixed ones).
 */
export function exportParams(input: {
  readonly query: Query;
  readonly paging: ListPagingMode;
  readonly zone: string;
  readonly format: string;
  readonly columns: readonly OptionalColumn[];
  readonly selection: ExportSelection;
  readonly now?: Date;
}): string {
  const { selection, query } = input;
  const params = new URLSearchParams();
  if (selection.allMatching) {
    for (const [key, value] of selectorParams(query, {
      paging: input.paging,
      zone: input.zone,
      now: input.now ?? new Date(),
    })) {
      params.set(key, value);
    }
    params.set('sort', query.sort);
    params.set('direction', query.direction);
  } else {
    if (selection.ids.length === 0) throw new Error('export.no-rows-selected');
    params.set('ids', selection.ids.slice(0, SELECTION_MAX).join(','));
  }
  params.set('format', input.format);
  if (input.columns.length > 0) params.set('columns', input.columns.join(','));
  return params.toString();
}

/**
 * The Bulk action menu of the queue: its one action is Export. The API has no bulk decision (each
 * decision reads its own review page), so there is no other item. The button is disabled until a
 * row is selected.
 */
export function QueueBulk({
  selection,
  query,
  paging,
  zone,
  columns,
}: {
  readonly selection: ExportSelection;
  readonly query: Query;
  readonly paging: ListPagingMode;
  readonly zone: string;
  readonly columns: readonly OptionalColumn[];
}) {
  const t = useTranslations('certificates.queue.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const { item, dialog, busy } = useSalesExport({
    path: 'certification/admin/seller-certificates/export',
    fallbackName: 'certificate-queue',
    listQuery: '',
    columns,
    zone,
    selection,
    buildQuery: (format) => exportParams({ query, paging, zone, format, columns, selection }),
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
