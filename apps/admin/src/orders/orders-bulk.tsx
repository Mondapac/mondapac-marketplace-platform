'use client';

import { ActionMenu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useSalesExport, type ExportSelection } from '../sales/sales-export.tsx';
import { exportColumnIds, type OrderColumn } from './orders-columns.ts';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export type BulkSelection = ExportSelection;

/**
 * The Bulk action button of the Orders header. Its one action is Export: a CSV or XLSX file of the
 * ticked orders or, after "Select all matching", of every order the tab, filters and id search
 * match, with the columns shown (the file names no buyer). A customer or store name search is not
 * an export filter, so "all matching" stays off while one is typed; ticked rows do not need the
 * filter. There is no bulk status change. The query and the download are in `sales-export.tsx`.
 */
export function OrdersBulk({
  selection,
  exportQuery,
  columns,
  nameSearch,
  empty,
}: {
  readonly selection: BulkSelection;
  /** The filters of the list as the export route reads them (no paging, no sort). */
  readonly exportQuery: () => string;
  /** The columns the admin chose, in the shown order (the fixed ones are not in it). */
  readonly columns: readonly OrderColumn[];
  /** True while the search box holds a customer or store name, which the export cannot filter by. */
  readonly nameSearch: boolean;
  /** True when the list shows no orders: there is nothing to export. */
  readonly empty: boolean;
}) {
  const t = useTranslations('orders.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const blocked = empty || (nameSearch && selection.allMatching);
  const { item, dialog, busy } = useSalesExport({
    path: 'ordering/admin/orders/export',
    fallbackName: 'orders',
    // Ticked rows are named by id and the route ignores the filter then; the relay would refuse
    // a name search as a filter value.
    listQuery: selection.allMatching ? exportQuery() : '',
    columns: exportColumnIds(columns),
    zone: null,
    selection,
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <ActionMenu
        label={t('button')}
        title={
          selection.allMatching && selection.total === null
            ? t('all-open')
            : t('selected', { count })
        }
        items={[{ ...item, disabled: item.disabled === true || blocked }]}
        disabled={!selected || busy}
        {...(selected ? {} : { hint: t('none-selected') })}
      />
      {/* A disabled item cannot take focus: the reason is plain text, not only a title. */}
      {nameSearch && selection.allMatching ? (
        <p className="text-sm text-fg-muted">{t('export-name-search')}</p>
      ) : null}
      {dialog}
    </div>
  );
}
