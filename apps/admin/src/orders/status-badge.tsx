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

/** The status of an order as a badge; an unlisted value reads "Unknown". */
export function OrderStatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('orders');
  const key = known(status, STATUSES);
  return <Badge tone={STATUS_TONE[key] ?? 'neutral'}>{t(`status.${key}`)}</Badge>;
}

/** The fulfilment state of one seller's part of an order as a badge. */
export function FulfilmentBadge({ fulfilment }: { readonly fulfilment: string }) {
  const t = useTranslations('orders');
  const key = known(fulfilment, FULFILMENTS);
  return <Badge tone={FULFILMENT_TONE[key] ?? 'neutral'}>{t(`fulfilment.${key}`)}</Badge>;
}
