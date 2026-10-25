import { useLocale, useTranslations } from 'next-intl';
import { formatClock } from '../format/clock.ts';
import type { SellerShop } from '../storefront/types.ts';

/**
 * What the seller page says about delivery times: the seller's own terms in words ("Order by 2 pm
 * for delivery tomorrow, 8 am–12 pm"), else the sample's ready-made text, else nothing. The times
 * are the seller's wall clock, shown as written, without a time zone.
 */
export function useDeliveryLine(shop: Pick<SellerShop, 'delivery' | 'deliveryWindow'>) {
  const t = useTranslations('seller');
  const locale = useLocale();
  const { delivery } = shop;
  if (delivery === undefined) return shop.deliveryWindow;
  const clock = (time: string) => formatClock(time, locale, t('end-of-day'));
  return t(delivery.day === 'same-day' ? 'delivery-today' : 'delivery-tomorrow', {
    cutoff: clock(delivery.cutoff),
    from: clock(delivery.from),
    to: clock(delivery.to),
  });
}
