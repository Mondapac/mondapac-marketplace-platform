'use client';

import { Banner, Card } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import type { ActivityEvent } from './types.ts';

/**
 * What happened to this order, oldest first, from payment on: the shop's own steps and the
 * refunds. Read-only. `events` is null when the list did not load.
 */
export function OrderTimeline({ events }: { readonly events: readonly ActivityEvent[] | null }) {
  const t = useTranslations('orders.timeline');
  const locale = useLocale();
  const zone = useTimeZone();
  return (
    <Card title={t('title')}>
      {events === null ? (
        <Banner tone="attention">{t('unavailable')}</Banner>
      ) : events.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('empty')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {events.map((event, index) => (
            <li key={`${event.kind}-${event.refundId ?? ''}-${index}`} className="flex flex-col">
              <span>
                {t(`event.${event.kind}`, {
                  amount:
                    event.amount === null
                      ? ''
                      : formatMinor(event.amount.amount, event.amount.currency, locale),
                })}
              </span>
              <span className="text-sm text-fg-muted">
                {shortInstant(event.at, locale, zone)}
                {event.by === null ? '' : ` · ${t(`by.${event.by}`)}`}
                {event.reason === 'item-unavailable' ? ` · ${t('reason.item-unavailable')}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
