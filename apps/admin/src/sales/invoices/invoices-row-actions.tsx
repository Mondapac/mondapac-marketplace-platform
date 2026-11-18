'use client';

import type { MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ROW_ACTIONS, type DocumentRow } from './invoices-types.ts';

/**
 * The Actions menu of a document row: exactly the actions the row's `actions` array names (the
 * server decides per caller and row), in a fixed order; an id this panel does not know is ignored.
 * View order opens the order page; Open order confirmation opens its printable page (one per
 * order, whichever seller order the row is).
 */
export function useInvoiceRowActions(): (row: DocumentRow) => readonly MenuItem[] {
  const t = useTranslations('invoices.actions');
  const router = useRouter();
  return (row) =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action): MenuItem => {
      const order = `/orders/${encodeURIComponent(row.orderId)}`;
      switch (action) {
        case 'view-order':
          return { id: action, label: t('view-order'), onSelect: () => router.push(order) };
        case 'download-order-document':
          return {
            id: action,
            label: t('open-confirmation'),
            onSelect: () => router.push(`${order}/document`),
          };
      }
    });
}
