'use client';

import { Banner } from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { usePoll } from '../security-centre/parts.tsx';
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
export function EmergencyStopBanner({ zone }: { readonly zone: string }) {
  const t = useTranslations('emergency-stop.banner');
  const format = useFormatter();
  const [stop, setStop] = useState<EmergencyStop | null>(null);
  const read = useCallback(async () => {
    const answer = await callApi<unknown>('GET', EMERGENCY_STOP_PATH);
    if (answer.ok) setStop(emergencyStopOf(answer.body));
  }, []);
  useEffect(() => {
    void read();
  }, [read]);
  usePoll(() => void read(), BANNER_POLL_MS);
  // The stop's own page shows the same state in its card (Reza).
  const onItsPage = (usePathname() ?? '').replace(/\/+$/, '').endsWith(EMERGENCY_STOP_HREF);
  if (stop === null || !stop.on || onItsPage) return null;
  const when =
    stop.changedAt === null
      ? null
      : format.dateTime(new Date(stop.changedAt), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: zone,
        });
  return (
    <div className="mb-4">
      <Banner tone="critical" title={t('title')}>
        <p>{t('body')}</p>
        <p className="mt-1">
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
    </div>
  );
}
