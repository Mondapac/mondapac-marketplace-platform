import { Badge, Card } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { formatInstant } from '../catalog/format.ts';
import { shortId } from '../orders/status.ts';
import type { OwnDispute } from './types.ts';

/** The orders a payment dispute holds now, each linking to its order. Absent when none is open. */
export function DisputedOrders({ disputes }: { readonly disputes: readonly OwnDispute[] }) {
  const t = useTranslations('disputes');
  const locale = useLocale();
  const zone = useTimeZone();
  const open = disputes.filter((dispute) => dispute.open);
  if (open.length === 0) return null;
  return (
    <Card title={t('card.title')}>
      <p className="text-sm text-fg-muted">{t('held')}</p>
      <ul className="flex flex-col divide-y divide-line-row">
        {open.map((dispute) => (
          <li
            key={dispute.sellerOrderId}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <a
                className="font-medium text-link underline"
                href={`/orders/${dispute.sellerOrderId}`}
              >
                {t('card.order', { id: shortId(dispute.sellerOrderId) })}
              </a>
              <p className="text-sm text-fg-muted">
                {t('card.since', { when: formatInstant(dispute.since, locale, zone) })}
              </p>
            </div>
            <Badge tone="critical">{t('badge')}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
