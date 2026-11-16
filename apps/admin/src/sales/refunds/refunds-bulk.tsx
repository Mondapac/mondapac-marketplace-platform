'use client';

import { ActionMenu, type ActionMenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Refunds the tab, search and filters match; null with Previous and next. */
  readonly total: number | null;
}

/**
 * The Bulk action button of the Refunds header. These lists are read only, so the one bulk
 * action is Export, and the export endpoint is not built yet (it follows in a later PR). Until
 * then there is no item: the button shows, disabled, with a hint saying so, and the selection bar
 * under the toolbar carries the count, "Select all matching" and Clear selection.
 *
 * The later PR adds the Export item to `items` below, a `useState<'export' | null>` for its
 * dialog, an `ExportDialog` from `@mondapac/ui` (as `catalog/products-bulk.tsx` does) and the
 * download. It needs `selection` (ids or "all matching" with the list's own query) and the
 * visible columns, which is why this component already takes the selection.
 */
export function RefundsBulk({ selection }: { readonly selection: BulkSelection }) {
  const t = useTranslations('refunds.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const items: ActionMenuItem[] = [];
  return (
    <ActionMenu
      label={t('button')}
      title={
        selection.allMatching && selection.total === null ? t('all-open') : t('selected', { count })
      }
      items={items}
      disabled={items.length === 0 || !selected}
      {...(items.length === 0 && selected ? { hint: t('none-yet') } : {})}
    />
  );
}
