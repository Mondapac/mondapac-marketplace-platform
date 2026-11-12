'use client';

import { Badge, Banner, Button, Card, EmptyState, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from '../catalog/format.ts';
import {
  HEALTH_METRICS,
  HEALTH_PATH,
  REFRESH_PATH,
  type HealthBand,
  type HealthMetric,
  type HealthMetricRow,
  type HealthTrendPoint,
  type OwnHealth,
} from './types.ts';

const TONE: Record<HealthBand, BadgeTone> = {
  healthy: 'success',
  'at-risk': 'attention',
  unhealthy: 'critical',
};

/** After a click the page asks again this often, for this many tries, until a new count shows. */
const POLL_MS = 20_000;
const POLL_TRIES = 9;

const knownMetric = (metric: string): HealthMetric | null =>
  (HEALTH_METRICS as readonly string[]).includes(metric) ? (metric as HealthMetric) : null;

/** The 90-day trend as a small line: the text beside it says the same in words. */
function Trend({ points }: { readonly points: readonly HealthTrendPoint[] }) {
  const t = useTranslations('performance.trend');
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

function MetricRow({ row }: { readonly row: HealthMetricRow }) {
  const t = useTranslations('performance.metric');
  const key = knownMetric(row.metric);
  if (key === null) return null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
      <div className="min-w-0">
        <div className="font-medium text-fg">{t(`${key}.name`)}</div>
        <div className="text-sm text-fg-muted">{t(`${key}.what`)}</div>
      </div>
      {row.kind === 'scored' && row.band !== undefined && row.band !== null ? (
        <Badge tone={TONE[row.band]}>
          {t(`band.${row.band}`)} · {row.score}
        </Badge>
      ) : (
        <span className="text-sm text-fg-muted">{t('no-data')}</span>
      )}
    </li>
  );
}

/**
 * The seller's own health: the score in plain words, the five measures, the 90-day line, how it
 * is calculated, and "Refresh now" with the cooldown the API answers with. Health only informs:
 * nothing here changes the store. The numbers come from what the nightly run stored.
 */
export function Performance({
  initial,
  csrfToken,
}: {
  readonly initial: OwnHealth;
  readonly csrfToken: string;
}) {
  const t = useTranslations('performance');
  const locale = useLocale();
  const zone = useTimeZone() ?? null;
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'throttled' | 'unavailable' | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(initial.refresh.retryAfterSeconds);
  const polls = useRef(0);

  const reread = useCallback(async () => {
    const result = await callApi<OwnHealth>('GET', HEALTH_PATH);
    if (result.ok) {
      setData(result.body);
      setWaitSeconds(result.body.refresh.retryAfterSeconds);
      return result.body;
    }
    return null;
  }, []);

  // The cooldown counts down on the page, so the button wakes up by itself.
  useEffect(() => {
    if (waitSeconds <= 0) return;
    const timer = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [waitSeconds]);

  // While a recount waits, ask again (the job runs about every minute) until it is done.
  useEffect(() => {
    if (!data.refresh.pending || polls.current >= POLL_TRIES) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void reread();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [data, reread]);

  async function refresh() {
    setBusy(true);
    setProblem(null);
    const result = await callApi<{ status: string }>('POST', REFRESH_PATH, {}, csrfToken);
    setBusy(false);
    if (!result.ok) {
      if (result.failure.code === 'request.throttled') {
        setProblem('throttled');
        setWaitSeconds(result.failure.details?.retryAfterSeconds ?? 900);
      } else {
        setProblem('unavailable');
      }
      return;
    }
    polls.current = 0;
    await reread();
  }

  const card = data.current;
  const minutes = Math.max(1, Math.ceil(waitSeconds / 60));
  const lowest =
    card?.lowestMetric === null || card?.lowestMetric === undefined
      ? null
      : knownMetric(card.lowestMetric);
  const canRefresh = waitSeconds <= 0 && !data.refresh.pending;

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-fg-muted">{t('intro')}</p>
      {card === null ? (
        <EmptyState size="page" icon="star" title={t('empty.title')} body={t('empty.body')} />
      ) : (
        <Card title={t('card.title')}>
          <div className="flex flex-wrap items-center gap-3">
            {card.kind === 'scored' && card.band !== null && card.score !== null ? (
              <Badge tone={TONE[card.band]}>
                {t(`metric.band.${card.band}`)} · {card.score}
              </Badge>
            ) : card.kind === 'new' ? (
              <Badge tone="neutral">{t('state.new')}</Badge>
            ) : (
              <Badge tone="neutral">{t('state.no-data')}</Badge>
            )}
            <span className="text-sm text-fg-muted">
              {t('measured', { when: shortInstant(card.computedAt, locale, zone) })}
            </span>
          </div>
          <p className="text-fg">
            {card.kind === 'scored' && card.band !== null
              ? lowest !== null
                ? t(`summary.${card.band}`, { metric: t(`metric.${lowest}.name`) })
                : t(`summary-plain.${card.band}`)
              : card.kind === 'new'
                ? t('summary.new', { orders: card.orders })
                : t('summary.no-data')}
          </p>
          <ul className="divide-y divide-line">
            {card.metrics.map((row) => (
              <MetricRow key={row.metric} row={row} />
            ))}
          </ul>
          <Trend points={data.trend} />
        </Card>
      )}
      <Card title={t('refresh.title')}>
        <p className="text-sm text-fg-muted">{t('refresh.body')}</p>
        {problem === 'unavailable' ? (
          <Banner tone="critical">{t('refresh.unavailable')}</Banner>
        ) : null}
        {data.refresh.pending ? <Banner tone="info">{t('refresh.pending')}</Banner> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void refresh()} loading={busy} disabled={!canRefresh || busy}>
            {t('refresh.button')}
          </Button>
          {waitSeconds > 0 ? (
            <span className="text-sm text-fg-muted">{t('refresh.wait', { minutes })}</span>
          ) : null}
        </div>
      </Card>
      <Card title={t('how.title')}>
        <p className="text-sm text-fg">{t('how.score')}</p>
        <ul className="list-disc ps-5 text-sm text-fg">
          {HEALTH_METRICS.map((metric) => (
            <li key={metric}>
              <span className="font-medium">{t(`metric.${metric}.name`)}</span>
              {': '}
              {t(`metric.${metric}.how`)}
            </li>
          ))}
        </ul>
        <p className="text-sm text-fg">{t('how.fair')}</p>
        <p className="text-sm text-fg">{t('how.nothing-automatic')}</p>
      </Card>
    </div>
  );
}
