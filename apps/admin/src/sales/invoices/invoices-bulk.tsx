'use client';

import { ActionMenu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ListPagingMode } from '../cursor-paging.ts';
import { useSalesExport, type ExportSelection } from '../sales-export.tsx';
import { columnsOnTab, type OptionalColumn } from './invoices-columns.ts';
import { queryString } from './invoices-query.ts';
import type { Query } from './invoices-types.ts';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export type BulkSelection = ExportSelection;

/**
 * The Bulk action button of the Invoices header. These lists are read only, so the one bulk
 * action is Export (Reza's spec 0.8): a CSV or XLSX file of the ticked rows or, after "Select all
 * matching", of every row the filter matches, with the columns shown, in the order shown. The
 * button is disabled until a row is selected. The query and the download are in `sales-export.tsx`.
 */
export function InvoicesBulk({
  selection,
  query,
  paging,
  zone,
  columns,
}: {
  readonly selection: BulkSelection;
  /** The list's own query: the tab, search, filters (the export sends the same keys). */
  readonly query: Query;
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times (ADR-0005). */
  readonly zone: string;
  /** The columns the admin chose, in the shown order (the fixed ones are not in it). */
  readonly columns: readonly OptionalColumn[];
}) {
  const t = useTranslations('invoices.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const kind = query.tab === 'credit-note' ? 'credit' : 'confirmation';
  const { item, dialog, busy } = useSalesExport({
    path: 'ordering/admin/documents/export',
    fallbackName: query.tab === 'credit-note' ? 'credit-notes' : 'order-confirmations',
    listQuery: queryString(query, { paging, zone, now: new Date() }),
    columns: columnsOnTab(columns, query.tab),
    zone,
    selection,
  });
  return (
    <>
      <ActionMenu
        label={t('button')}
        title={
          selection.allMatching && selection.total === null
            ? t('all-open', { kind })
            : t('selected', { count, kind })
        }
        items={[item]}
        disabled={!selected || busy}
      />
      {dialog}
    </>
  );
}
