'use client';

import { ActionMenu, type ActionMenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { OrderColumn } from './orders-columns.ts';
import { useOrdersExport } from './orders-export.tsx';

/** The most orders one set of packing slips takes (the list's selection limit). */
export const SLIPS_MAX = 50;

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Orders the tab, search and filter match; null with Previous and next. */
  readonly total: number | null;
}

/**
 * The Bulk action button of the Orders header: Print packing slips for up to 50 ticked orders (it
 * opens one printable page in a new tab; orders already sent or refunded in full are named there as
 * left out). The slips need the orders themselves, so "Select all matching" cannot print them. The
 * other action is Export: a CSV or XLSX file of the ticked orders or, with none ticked or after
 * "Select all matching", of every order the tab and paid dates match (the export route takes no
 * search, so a search turns the whole-list file off; ticked orders do not need the filter). There
 * is no bulk status change.
 */
export function OrdersBulk({
  selection,
  exportQuery,
  columns,
  zone,
  searching,
  empty,
}: {
  readonly selection: BulkSelection;
  /** The filters of the list as the export route reads them (no search, paging or sort). */
  readonly exportQuery: () => string;
  /** The columns the seller chose, in the shown order (the fixed ones are not in it). */
  readonly columns: readonly OrderColumn[];
  /** The seller's zone, for the day in the file's name. */
  readonly zone: string;
  /** True while the search box holds an order id, which the export cannot filter by. */
  readonly searching: boolean;
  /** True when the list shows no orders: there is nothing to export. */
  readonly empty: boolean;
}) {
  const t = useTranslations('orders.bulk');
  const named = !selection.allMatching && selection.ids.length > 0;
  const exporter = useOrdersExport({
    listQuery: named ? '' : exportQuery(),
    columns,
    ids: selection.ids,
    allMatching: selection.allMatching,
    total: selection.total,
    zone,
  });

  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const canPrint = !selection.allMatching && selection.ids.length > 0;
  const items: ActionMenuItem[] = [
    {
      id: 'packing-slips',
      label: t('print-slips'),
      description: selection.allMatching
        ? t('print-slips-all')
        : t('print-slips-help', { max: SLIPS_MAX }),
      icon: 'clipboard',
      disabled: !canPrint,
      onSelect: () => {
        const ids = selection.ids.slice(0, SLIPS_MAX).join(',');
        window.open(`/orders/packing-slips?ids=${encodeURIComponent(ids)}`, '_blank', 'noopener');
      },
    },
    {
      id: 'export',
      label: t('export'),
      description: t('export-help'),
      icon: 'download',
      disabled: empty || (searching && !named) || exporter.busy,
      onSelect: exporter.open,
    },
  ];
  return (
    <div className="flex flex-col items-end gap-1">
      <ActionMenu
        label={t('button')}
        title={
          !selected
            ? t('none-selected')
            : selection.allMatching && selection.total === null
              ? t('all-open')
              : t('selected', { count })
        }
        items={items}
      />
      {/* A disabled item cannot take focus: the reason is plain text, not only a title. */}
      {searching && !named ? (
        <p className="text-sm text-fg-muted">{t('export-searching')}</p>
      ) : null}
      {exporter.dialog}
    </div>
  );
}
