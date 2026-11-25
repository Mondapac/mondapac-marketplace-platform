'use client';

import { ChartError } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

/**
 * The in-place error of a dashboard card with a secondary "Try again" that reads the page again
 * (the server starts every read anew). Used by the phase 2 cards.
 */
export function RetryError({ height = 120 }: { readonly height?: number }) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  return (
    <ChartError
      height={height}
      message={t('error.card')}
      retryLabel={t('kpis.retry')}
      onRetry={() => router.refresh()}
    />
  );
}
