import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { known } from '../sellers/format.ts';
import { FULFILMENTS, STATUSES } from './types.ts';

const STATUS_TONE: Record<string, BadgeTone> = {
  'pending-payment': 'attention',
  confirmed: 'success',
  cancelled: 'neutral',
};

const FULFILMENT_TONE: Record<string, BadgeTone> = {
  'to-ship': 'attention',
  shipped: 'info',
  delivered: 'success',
};

/**
 * The status an order shows: a paid order an admin cancelled (Cancel and refund) keeps the stored
 * status `confirmed`, and shows as cancelled.
 */
export const displayStatusOf = (order: {
  readonly status: string;
  readonly cancelledAt: string | null;
}): string =>
  order.status === 'confirmed' && order.cancelledAt !== null ? 'cancelled' : order.status;

/** The status of an order as a badge; an unlisted value reads "Unknown". */
export function OrderStatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('orders');
  const key = known(status, STATUSES);
  return <Badge tone={STATUS_TONE[key] ?? 'neutral'}>{t(`status.${key}`)}</Badge>;
}

/**
 * The fulfilment state of one seller's part of an order as a badge. A part an admin cancelled
 * shows Cancelled (it stays to-ship and is never prepared).
 */
export function FulfilmentBadge({
  fulfilment,
  cancelled = false,
}: {
  readonly fulfilment: string;
  readonly cancelled?: boolean;
}) {
  const t = useTranslations('orders');
  if (cancelled) return <Badge tone="neutral">{t('status.cancelled')}</Badge>;
  const key = known(fulfilment, FULFILMENTS);
  return <Badge tone={FULFILMENT_TONE[key] ?? 'neutral'}>{t(`fulfilment.${key}`)}</Badge>;
}
