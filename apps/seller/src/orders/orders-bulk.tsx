'use client';

import { ActionMenu, type ActionMenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

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
 * one other bulk action, Export, follows with its endpoint. There is no bulk status change.
 */
export function OrdersBulk({ selection }: { readonly selection: BulkSelection }) {
  const t = useTranslations('orders.bulk');
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
  ];
  return (
    <ActionMenu
      label={t('button')}
      title={
        selection.allMatching && selection.total === null ? t('all-open') : t('selected', { count })
      }
      items={items}
      disabled={!selected}
      {...(selected ? {} : { hint: t('none-selected') })}
    />
  );
}
