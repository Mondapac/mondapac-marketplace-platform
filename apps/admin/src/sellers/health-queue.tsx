import { Badge, EmptyState } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstant } from '../shared/format.ts';
import { HEALTH_METRICS, type HealthQueueRead } from './health-types.ts';

const known = (metric: string): (typeof HEALTH_METRICS)[number] | null =>
  (HEALTH_METRICS as readonly string[]).includes(metric)
    ? (metric as (typeof HEALTH_METRICS)[number])
    : null;

/**
 * The sellers whose latest stored health is unhealthy, worst score first (seller health package
 * 5). It only informs: each row links to the seller page, and nothing here acts on a seller.
 */
export function HealthQueue({ queue }: { readonly queue: HealthQueueRead }) {
  const t = useTranslations('sellers.health-queue');
  const locale = useLocale();
  if (queue.items.length === 0) {
    return <EmptyState size="page" icon="store" title={t('empty.title')} body={t('empty.body')} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <div className="relative overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-120 text-start text-sm">
          <caption className="sr-only">{t('title')}</caption>
          <thead className="bg-muted text-fg-muted">
            <tr>
              <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                {t('col.seller')}
              </th>
              <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                {t('col.score')}
              </th>
              <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                {t('col.lowest')}
              </th>
              <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                {t('col.measured')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-row">
            {queue.items.map((item) => {
              const metric = known(item.lowestMetric);
              return (
                <tr key={item.sellerId}>
                  <td className="px-3 py-3 font-medium">
                    <a className="text-link underline" href={`/sellers/${item.sellerId}`}>
                      {item.storeName ?? t('unnamed')}
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <Badge tone="critical">
                      {t('unhealthy')} · {item.score}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">{metric === null ? '-' : t(`metric.${metric}`)}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <time dateTime={item.day}>{shortInstant(item.day, locale)}</time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {queue.truncated ? <p className="text-sm text-fg-muted">{t('truncated')}</p> : null}
      <p className="text-sm text-fg-muted">{t('informs')}</p>
    </div>
  );
}
