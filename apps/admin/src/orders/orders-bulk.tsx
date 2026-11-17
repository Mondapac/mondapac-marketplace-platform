'use client';

import { ActionMenu, type ActionMenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Orders the tab, search and filters match; null with Previous and next. */
  readonly total: number | null;
}

/**
 * The Bulk action button of the Orders header. The one bulk action is Export, and the export
 * endpoint is not built yet (order export, B1-2, follows with its own PR). Until then there is no
 * item: the button shows, disabled, with a hint saying so, and the selection bar under the toolbar
 * carries the count, "Select all matching" and Clear selection. The export PR adds the Export item
 * here, with its dialog, as `catalog/products-bulk.tsx` does. There is no bulk status change.
 */
export function OrdersBulk({ selection }: { readonly selection: BulkSelection }) {
  const t = useTranslations('orders.bulk');
  const count = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const items: ActionMenuItem[] = [];
  const hint = items.length === 0 && selected ? t('none-yet') : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <ActionMenu
        label={t('button')}
        title={
          selection.allMatching && selection.total === null
            ? t('all-open')
            : t('selected', { count })
        }
        items={items}
        disabled={items.length === 0 || !selected}
        {...(hint === null ? {} : { hint })}
      />
      {/* A disabled button cannot take focus: the reason is plain text under it, not only a title. */}
      {hint === null ? null : <p className="text-sm text-fg-muted">{hint}</p>}
    </div>
  );
}
