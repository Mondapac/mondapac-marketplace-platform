'use client';

import { ActionMenu, toast, type ActionMenuItem } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef } from 'react';
import { numberFormat } from '../shared/intl.ts';
import { downloadOrders } from './export-file.ts';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Orders the tab, search and filters match; null with Previous and next. */
  readonly total: number | null;
}

/** The export route the panel relays (`ordering/admin/orders/export`). */
const EXPORT_PATH = 'ordering/admin/orders/export';

/**
 * The Bulk action button of the Orders header. Its one action is Export CSV: the file holds every
 * order the tab, filters and id search match, not only the page or the ticked rows (the export
 * route takes filters, not ids). A name search is not an export filter, so the item says so and
 * stays off until it is cleared. The kit export dialog (CSV and XLSX, chosen columns) follows with
 * order export B1-2. There is no bulk status change.
 */
export function OrdersBulk({
  selection,
  exportQuery,
  nameSearch,
  empty,
}: {
  readonly selection: BulkSelection;
  /** The filters of the list as the export route reads them (no paging, no sort), read at click. */
  readonly exportQuery: () => string;
  /** True while the search box holds a customer or store name, which the export cannot filter by. */
  readonly nameSearch: boolean;
  /** True when the list shows no orders: there is nothing to export. */
  readonly empty: boolean;
}) {
  const t = useTranslations('orders.bulk');
  const te = useTranslations('orders.export');
  const locale = useLocale();
  const busy = useRef(false);

  async function exportFile() {
    if (busy.current) return;
    busy.current = true;
    const outcome = await downloadOrders(EXPORT_PATH, exportQuery());
    busy.current = false;
    if (outcome.ok) toast.success(te('done'));
    else if (outcome.reason === 'session') window.location.assign('/session-ended');
    else if (outcome.reason === 'too-large') {
      toast.error(
        outcome.matching === undefined || outcome.max === undefined
          ? te('too-large-plain')
          : te('too-large', {
              matching: numberFormat(locale, {}).format(outcome.matching),
              max: numberFormat(locale, {}).format(outcome.max),
            }),
      );
    } else toast.error(te(outcome.reason));
  }

  const items: ActionMenuItem[] = [
    {
      id: 'export',
      label: t('export'),
      disabled: nameSearch || empty,
      onSelect: () => void exportFile(),
    },
  ];
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <ActionMenu
        label={t('button')}
        title={
          !selected
            ? t('export-help')
            : selection.allMatching && selection.total === null
              ? t('all-open')
              : t('selected', { count })
        }
        items={items}
      />
      {/* A disabled item cannot take focus: the reason is plain text, not only a title. */}
      {nameSearch ? <p className="text-sm text-fg-muted">{t('export-name-search')}</p> : null}
    </div>
  );
}
