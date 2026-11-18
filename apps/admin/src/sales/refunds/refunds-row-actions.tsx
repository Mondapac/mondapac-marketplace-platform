'use client';

import { toast, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ROW_ACTIONS, type RefundRow } from './refunds-types.ts';

/**
 * The Actions menu of a refund row: exactly the actions the row's `actions` array names (the
 * server decides per caller and row), in a fixed order; an id this panel does not know is ignored.
 * View order goes to the order page; Copy Stripe refund ID copies Stripe's id and says so in a
 * toast, or says it could not.
 */
export function useRefundRowActions(): (row: RefundRow) => readonly MenuItem[] {
  const t = useTranslations('refunds.actions');
  const router = useRouter();

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copy-failed'));
    }
  }

  return (row) =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).flatMap((action): MenuItem[] => {
      switch (action) {
        case 'view-order':
          return [
            {
              id: action,
              label: t('view-order'),
              onSelect: () => router.push(`/orders/${encodeURIComponent(row.orderId)}`),
            },
          ];
        case 'copy-stripe-reference': {
          // The API offers the copy only once Stripe made the refund; without an id there is
          // nothing to copy.
          const reference = row.stripeRefundId;
          if (reference === null || reference === '') return [];
          return [{ id: action, label: t('copy-stripe'), onSelect: () => void copy(reference) }];
        }
      }
    });
}
