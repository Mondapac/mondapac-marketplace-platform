'use client';

import { toast, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { shortId } from '../shared/short-id.ts';
import { orderHref, type CustomerOrigin } from './order-href.ts';
import { ROW_ACTIONS, type AdminOrderRow } from './types.ts';

/**
 * The Actions menu of an order row: exactly the actions the row's `actions` array names (the
 * server decides per caller and row), in the menu order; an id this panel does not know is
 * ignored. Open, Print document and Copy number are safe and run at once. Add note, Refund… and
 * Cancel order… lead to the order page, where the note box, the seller order's Refund… and the
 * cancel dialog (with its reason, loss bearer and step-up) are; the page opens the cancel dialog
 * itself when it is reached from here.
 */
export function useOrderRowActions(
  /** Opened from a customer's page: Open keeps the way back to that tab. */
  from?: CustomerOrigin,
): (row: AdminOrderRow) => readonly MenuItem[] {
  const t = useTranslations('orders.row-actions');
  const router = useRouter();

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copy-failed'));
    }
  }

  return (row) => {
    const page = `/orders/${encodeURIComponent(row.orderId)}`;
    // From a customer's tab every way into the order keeps the way back to that tab.
    const into = orderHref(row.orderId, from);
    const withQuery = (extra: string) => `${into}${into.includes('?') ? '&' : '?'}${extra}`;
    return ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action): MenuItem => {
      switch (action) {
        case 'open':
          return {
            id: action,
            label: t('open'),
            onSelect: () => router.push(into),
          };
        case 'print-document':
          return { id: action, label: t('print'), onSelect: () => router.push(`${page}/document`) };
        case 'copy-number':
          return { id: action, label: t('copy-number'), onSelect: () => void copy(row.orderId) };
        case 'add-note':
          return { id: action, label: t('add-note'), onSelect: () => router.push(`${into}#notes`) };
        case 'refund':
          return {
            id: action,
            label: t('refund'),
            tone: 'critical',
            onSelect: () => router.push(`${into}#seller-orders`),
          };
        case 'cancel':
          return {
            id: action,
            label: t('cancel', { id: shortId(row.orderId) }),
            tone: 'critical',
            onSelect: () => router.push(withQuery('do=cancel')),
          };
      }
    });
  };
}
