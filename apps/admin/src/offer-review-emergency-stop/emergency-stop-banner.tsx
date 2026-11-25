'use client';

import { Banner } from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { usePoll } from '../security-centre/parts.tsx';
import { API_STOPS, stopsOf, type Stops } from '../offer-review/types.ts';
import {
  BANNER_POLL_MS,
  EMERGENCY_STOP_HREF,
  EMERGENCY_STOP_PATH,
  emergencyStopOf,
  type EmergencyStop,
} from './types.ts';

/**
 * The warning on every admin page while the Offer review emergency stop is on (design 9.5 b): who
 * switched it on and when, read every 60 s while the tab is visible. Nothing shows while it is off
 * or when the read fails. The link opens the page that switches it.
 */
export function EmergencyStopBanner({
  zone,
  canViewStops = false,
}: {
  readonly zone: string;
  /** The admin holds `catalog.product.view`, the key of the seller and category stop counts. */
  readonly canViewStops?: boolean;
}) {
  const t = useTranslations('emergency-stop.banner');
  const format = useFormatter();
  const [stop, setStop] = useState<EmergencyStop | null>(null);
  const [stops, setStops] = useState<Stops | null>(null);
  const read = useCallback(async () => {
    const [market, counts] = await Promise.all([
      callApi<unknown>('GET', EMERGENCY_STOP_PATH),
      // A failed read shows nothing and never blocks the page; the next poll tries again.
      canViewStops ? callApi<unknown>('GET', API_STOPS) : Promise.resolve(null),
    ]);
    if (market.ok) setStop(emergencyStopOf(market.body));
    if (counts?.ok) setStops(stopsOf(counts.body));
  }, [canViewStops]);
  useEffect(() => {
    void read();
  }, [read]);
  usePoll(() => void read(), BANNER_POLL_MS);
  // The stop's own page shows the same state in its card (Reza).
  const onItsPage = (usePathname() ?? '').replace(/\/+$/, '').endsWith(EMERGENCY_STOP_HREF);
  const marketOn = stop !== null && stop.on && !onItsPage;
  const sellers = stops?.stoppedSellers ?? 0;
  const categories = stops?.stoppedCategories ?? 0;
  const partial = sellers > 0 || categories > 0;
  if (!marketOn && !partial) return null;
  const when =
    stop === null || stop.changedAt === null
      ? null
      : format.dateTime(new Date(stop.changedAt), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: zone,
        });
  return (
    <div className="mb-3 flex flex-col gap-2 sm:mb-4">
      {marketOn && stop !== null ? (
        <Banner tone="critical" title={t('title')}>
          {/* On a phone the title and the link are one compact block; the sentence stays for a screen reader. */}
          <p className="max-sm:sr-only">{t('body')}</p>
          <p className="mt-1 max-sm:mt-0">
            {stop.changedBy !== null && when !== null
              ? t('by-at', { name: stop.changedBy, when })
              : when !== null
                ? t('at', { when })
                : null}{' '}
            <a className="font-semibold underline" href={EMERGENCY_STOP_HREF}>
              {t('link')}
            </a>
          </p>
        </Banner>
      ) : null}
      {partial ? (
        <Banner tone="attention" title={t('partial.title')}>
          <p>
            {t(
              `partial.body-${sellers > 0 && categories > 0 ? 'both' : sellers > 0 ? 'sellers' : 'categories'}`,
              {
                sellers,
                categories,
              },
            )}{' '}
            {sellers > 0 ? (
              <a className="font-semibold underline" href="/sellers">
                {t('partial.sellers')}
              </a>
            ) : null}
            {sellers > 0 && categories > 0 ? ' · ' : null}
            {categories > 0 ? (
              <a className="font-semibold underline" href="/settings/offer-review/categories">
                {t('partial.categories')}
              </a>
            ) : null}
          </p>
        </Banner>
      ) : null}
    </div>
  );
}
