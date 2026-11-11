'use client';

import { Badge, Banner, Button, Card, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import {
  HEALTH_METRICS,
  recalculatePath,
  type HealthBand,
  type HealthTrendPoint,
  type SellerHealthRead,
} from './health-types.ts';

const TONE: Record<HealthBand, BadgeTone> = {
  healthy: 'success',
  'at-risk': 'attention',
  unhealthy: 'critical',
};

const known = (metric: string): (typeof HEALTH_METRICS)[number] | null =>
  (HEALTH_METRICS as readonly string[]).includes(metric)
    ? (metric as (typeof HEALTH_METRICS)[number])
    : null;

/** The 90-day trend as a small line; the text beside it says the same in words. */
function Trend({ points }: { readonly points: readonly HealthTrendPoint[] }) {
  const t = useTranslations('sellers.health.trend');
  const scored = points.filter((p) => p.score !== null);
  if (scored.length < 2) return <p className="text-sm text-fg-muted">{t('too-short')}</p>;
  const width = 240;
  const height = 48;
  const step = width / (points.length - 1);
  const path = points
    .map((p, i) =>
      p.score === null
        ? null
        : `${(i * step).toFixed(1)},${(height - (p.score / 100) * height).toFixed(1)}`,
    )
    .filter((p): p is string => p !== null)
    .join(' ');
  const first = scored[0]!.score!;
  const last = scored[scored.length - 1]!.score!;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="h-12 w-60 text-accent">
        <polyline points={path} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <p className="text-sm text-fg-muted">{t('summary', { first, last, days: points.length })}</p>
    </div>
  );
}

/**
 * A seller's health on the admin review page (seller health package 5): the stored score, the five
 * measures, the trend, and "Recalculate now" for a role that holds the key. Health only informs:
 * nothing here acts on the seller. The job measures within about two minutes.
 */
export function SellerHealthCard({
  sellerId,
  initial,
  canRecalculate,
  csrfToken,
}: {
  readonly sellerId: string;
  readonly initial: SellerHealthRead;
  readonly canRecalculate: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('sellers.health');
  const locale = useLocale();
  const card = initial.current;
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<'queued' | 'already-queued' | 'failed' | null>(null);
  const busy = useRef(false);

  async function recalculate() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setOutcome(null);
    const result = await callApi<{ status: 'queued' | 'already-queued' }>(
      'POST',
      recalculatePath(sellerId),
      {},
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setOutcome(result.body.status);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setOutcome('failed');
  }

  const lowest = card?.lowestMetric == null ? null : known(card.lowestMetric);
  return (
    <Card title={t('title')}>
      {card === null ? (
        <p className="text-fg-secondary">{t('none')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {card.kind === 'scored' && card.band !== null ? (
              <Badge tone={TONE[card.band]}>
                {t(`band.${card.band}`)} · {card.score}
              </Badge>
            ) : (
              <Badge tone="neutral">{t(card.kind === 'new' ? 'new' : 'no-data')}</Badge>
            )}
            <span className="text-sm text-fg-muted">
              {t('measured', { when: formatInstant(card.computedAt, locale) })}
            </span>
          </div>
          {card.kind === 'scored' && lowest !== null ? (
            <p className="text-fg-secondary">{t('lowest', { metric: t(`metric.${lowest}`) })}</p>
          ) : null}
          <ul className="divide-y divide-line">
            {card.metrics.map((row) => {
              const key = known(row.metric);
              if (key === null) return null;
              return (
                <li key={row.metric} className="flex items-center justify-between gap-4 py-2">
                  <span>{t(`metric.${key}`)}</span>
                  {row.kind === 'scored' && row.band != null ? (
                    <Badge tone={TONE[row.band]}>
                      {t(`band.${row.band}`)} · {row.score}
                    </Badge>
                  ) : (
                    <span className="text-sm text-fg-muted">{t('no-data')}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <Trend points={initial.trend} />
        </div>
      )}
      {outcome === 'queued' || outcome === 'already-queued' ? (
        <Banner tone="success">{t(`outcome.${outcome}`)}</Banner>
      ) : null}
      {outcome === 'failed' ? <Banner tone="attention">{t('outcome.failed')}</Banner> : null}
      {canRecalculate ? (
        <div>
          <Button variant="secondary" loading={pending} onClick={() => void recalculate()}>
            {t('recalculate')}
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-fg-muted">{t('informs')}</p>
    </Card>
  );
}
