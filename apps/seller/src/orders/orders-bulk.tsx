'use client';

import { ActionMenu, toast, type ActionMenuItem } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef } from 'react';
import { numberFormat } from '../shared/intl.ts';
import { downloadOrders } from './export-file.ts';

/** The most orders one set of packing slips takes (the list's selection limit). */
export const SLIPS_MAX = 50;

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Orders the tab, search and filter match; null with Previous and next. */
  readonly total: number | null;
}

/** The export route the panel relays (`ordering/seller/orders/export`). */
const EXPORT_PATH = 'ordering/seller/orders/export';

/**
 * The Bulk action button of the Orders header: Print packing slips for up to 50 ticked orders (it
 * opens one printable page in a new tab; orders already sent or refunded in full are named there as
 * left out). The slips need the orders themselves, so "Select all matching" cannot print them. The
 * other action is Export CSV: the file holds every order the tab and paid dates match (the export
 * route takes no search), so a search turns it off. The kit export dialog follows with order
 * export B1-2. There is no bulk status change.
 */
export function OrdersBulk({
  selection,
  exportQuery,
  searching,
  empty,
}: {
  readonly selection: BulkSelection;
  /** The filters of the list as the export route reads them (no search, paging or sort). */
  readonly exportQuery: () => string;
  /** True while the search box holds an order id, which the export cannot filter by. */
  readonly searching: boolean;
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
      disabled: searching || empty,
      onSelect: () => void exportFile(),
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
      {searching ? <p className="text-sm text-fg-muted">{t('export-searching')}</p> : null}
    </div>
  );
}
