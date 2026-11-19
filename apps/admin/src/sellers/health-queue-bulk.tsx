'use client';

import { ActionMenu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useSalesExport, type ExportSelection } from '../sales/sales-export.tsx';
import {
  exportColumnIds,
  selectorParams,
  type OptionalColumn,
  type Query,
} from './health-list-query.ts';
import { HEALTH_QUEUE_EXPORT_PATH } from './health-types.ts';

/**
 * The Bulk action button of the "Needs a look" header. Health only informs, so there is no action
 * on a seller; the one item is Export: a CSV or XLSX file of the ticked sellers (up to 200 ids) or,
 * after "Select all matching", of every seller the view, search and score range match, in the
 * list's sort. The API takes the ids alone or the selector alone, so the list's keys are sent only
 * with "Select all matching". The button is disabled until a row is selected.
 */
export function HealthQueueBulk({
  selection,
  query,
  columns,
}: {
  readonly selection: ExportSelection;
  readonly query: Query;
  readonly columns: readonly OptionalColumn[];
}) {
  const t = useTranslations('sellers.health-queue.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const selector = selectorParams(query);
  selector.set('sort', query.sort);
  selector.set('direction', query.direction);
  const { item, dialog, busy } = useSalesExport({
    path: HEALTH_QUEUE_EXPORT_PATH,
    fallbackName: 'sellers-needing-attention',
    listQuery: selection.allMatching ? selector.toString() : '',
    columns: exportColumnIds(columns),
    zone: 'UTC',
    omitZone: true,
    keepOrder: true,
    selection,
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
