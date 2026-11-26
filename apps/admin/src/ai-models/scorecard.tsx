'use client';

import { Banner, Button, SettingsSection } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { dollars } from './evaluation-types.ts';
import {
  costPerThousand,
  errorPercent,
  roundDollars,
  type FamilyUsage,
  type ModelUsage,
} from './usage-types.ts';

/** The p95 bucket as text: "≤ 2 s", "> 32 s"; null without calls (the caller shows a dash). */
function latencyText(
  item: FamilyUsage,
  t: (key: string, values?: Record<string, string | number>) => string,
): string | null {
  if (item.p95 === null) return null;
  const seconds = item.p95.bound / 1000;
  return item.p95.above ? t('p95-above', { seconds }) : t('p95-at-most', { seconds });
}

/**
 * Settings › AI Models › Evaluation, Scorecard: per model family the last 30 days of real calls
 * (evaluation and playground calls left out): calls, cost per 1,000 calls, error rate, p95 latency,
 * how often it stood in for a model before it, and how many capabilities have a recorded
 * evaluation pass. Numbers only; read with the view key.
 */
export function Scorecard({
  usage,
  failed,
  loading,
  onRefresh,
}: {
  readonly usage: ModelUsage | null;
  readonly failed: boolean;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}) {
  const t = useTranslations('ai-models.scorecard');
  const locale = useLocale();
  const whole = (value: number) => new Intl.NumberFormat(locale).format(value);
  // Cents, unless the amount is below one cent (then every digit, so it never reads as zero).
  const money = (micro: number) =>
    t('money', { amount: micro >= 10_000 ? roundDollars(micro) : dollars(micro) });
  // A dash a screen reader reads as "No data", not "en dash".
  const shown = (value: string | null): ReactNode =>
    value === null ? <span aria-label={t('no-data')}>{t('dash')}</span> : value;
  const header = 'py-2 pe-4 text-end font-medium whitespace-nowrap';
  const cell = 'py-2 pe-4 text-end tabular-nums whitespace-nowrap';
  const empty = usage !== null && usage.families.every((item) => item.calls === 0);
  return (
    <SettingsSection
      title={t('section')}
      description={
        usage === null ? t('intro') : t('intro-days', { from: usage.from, to: usage.to })
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        {failed ? <Banner tone="critical">{t('failed')}</Banner> : null}
        {loading && usage === null ? (
          <p role="status" className="text-sm">
            {t('loading')}
          </p>
        ) : null}
        {empty ? <p className="text-sm">{t('empty')}</p> : null}
        {usage === null ? null : (
          <ul className="flex flex-col divide-y divide-line lg:hidden" aria-label={t('table')}>
            {usage.families.map((item) => {
              const per = costPerThousand(item);
              const rate = errorPercent(item);
              const facts: readonly (readonly [string, ReactNode])[] = [
                [t('col.calls'), whole(item.calls)],
                [t('col.cost-per-1000'), shown(per === null ? null : money(per))],
                [t('col.error-rate'), shown(rate === null ? null : t('percent', { value: rate }))],
                [t('col.p95'), shown(latencyText(item, t))],
                [t('col.stood-in'), whole(item.stoodIn)],
                [
                  t('col.evaluation'),
                  t('passed', { passed: item.evaluation.passed, of: item.evaluation.of }),
                ],
              ];
              return (
                <li key={item.family} className="flex flex-col gap-2 py-3 text-sm">
                  <p className="font-medium break-words">{item.family}</p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {facts.map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-fg-muted">{label}</dt>
                        <dd className="tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
        {usage === null ? null : (
          <div
            className="hidden overflow-x-auto lg:block"
            role="region"
            aria-label={t('table')}
            tabIndex={0}
          >
            <table className="w-full text-start text-sm">
              <caption className="sr-only">{t('table')}</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 pe-4 text-start font-medium">
                    {t('col.model')}
                  </th>
                  <th scope="col" className={header}>
                    {t('col.calls')}
                  </th>
                  <th scope="col" className={header}>
                    {t('col.cost-per-1000')}
                  </th>
                  <th scope="col" className={header}>
                    {t('col.error-rate')}
                  </th>
                  <th scope="col" className={header}>
                    {t('col.p95')}
                  </th>
                  <th scope="col" className={header}>
                    {t('col.stood-in')}
                  </th>
                  <th scope="col" className="py-2 text-end font-medium whitespace-nowrap">
                    {t('col.evaluation')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.families.map((item) => {
                  const per = costPerThousand(item);
                  const rate = errorPercent(item);
                  return (
                    <tr key={item.family} className="border-b border-line">
                      <th
                        scope="row"
                        className="py-2 pe-4 text-start font-normal whitespace-nowrap"
                      >
                        {item.family}
                      </th>
                      <td className={cell}>{whole(item.calls)}</td>
                      <td className={cell}>{shown(per === null ? null : money(per))}</td>
                      <td className={cell}>
                        {shown(rate === null ? null : t('percent', { value: rate }))}
                      </td>
                      <td className={cell}>{shown(latencyText(item, t))}</td>
                      <td className={cell}>{whole(item.stoodIn)}</td>
                      <td className="py-2 text-end tabular-nums whitespace-nowrap">
                        {t('passed', { passed: item.evaluation.passed, of: item.evaluation.of })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-sm text-fg-muted">{t('note')}</p>
        <div>
          <Button variant="secondary" disabled={loading} onClick={onRefresh}>
            {loading ? t('refreshing') : t('refresh')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
