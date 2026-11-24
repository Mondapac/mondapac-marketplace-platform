'use client';

import {
  ChartEmpty,
  DashboardCard,
  LineAreaChart,
  PeriodSelector,
  compactNumber,
  type ChartPoint,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { exponentOf, formatMinor } from '../../price/money.ts';

/** The measures the chart can switch between; each is a series the KPI endpoint already sends. */
export const MEASURES = ['sales', 'orders'] as const;
export type Measure = (typeof MEASURES)[number];

/** One day of the chart: both measures, so the switch needs no new read. */
export interface ChartDay {
  /** The x label as shown ("21 Nov"). */
  readonly label: string;
  /** Sales with GST, minor units. */
  readonly sales: number;
  readonly orders: number;
}

/**
 * The sales chart card with its measure switch (a native select on a phone). The switch is local:
 * both series arrive with the page. "No data" (no paid order in this period or the one before)
 * and "not enough data" (fewer than two days to draw a line through) are different states.
 */
export function SalesChartCard({
  id,
  scope,
  currency,
  locale,
  periodLabel,
  days,
  previousDays,
}: {
  readonly id: string;
  /** The line under the title (period, Market zone, last update). */
  readonly scope: string;
  readonly currency: string;
  readonly locale: string;
  /** "Last 30 days", for the text alternative. */
  readonly periodLabel: string;
  readonly days: readonly ChartDay[];
  readonly previousDays: readonly ChartDay[];
}) {
  const t = useTranslations('dashboard.kpi');
  const [measure, setMeasure] = useState<Measure>('sales');
  const exp = 10 ** exponentOf(currency);
  const noOrders =
    days.every((day) => day.orders === 0) && previousDays.every((day) => day.orders === 0);
  const points = (rows: readonly ChartDay[]): ChartPoint[] =>
    rows.map((day) => ({ label: day.label, value: day[measure] }));
  const count = new Intl.NumberFormat(locale);
  return (
    <DashboardCard
      id={id}
      title={t('chart.title')}
      scope={scope}
      headerRight={
        <PeriodSelector
          label={t('chart.measure.label')}
          options={MEASURES.map((m) => ({ id: m, label: t(`chart.measure.${m}`) }))}
          value={measure}
          onChange={(next) => {
            if ((MEASURES as readonly string[]).includes(next)) setMeasure(next as Measure);
          }}
        />
      }
    >
      {noOrders ? (
        <ChartEmpty message={t('chart.empty')} />
      ) : days.length < 2 ? (
        <ChartEmpty message={t('chart.insufficient')} hint={t('chart.insufficient-hint')} />
      ) : (
        <LineAreaChart
          title={t('chart.alt', { measure: t(`chart.measure.${measure}`), period: periodLabel })}
          points={points(days)}
          compare={points(previousDays)}
          seriesLabel={t('chart.series')}
          compareLabel={t('chart.compare')}
          formatValue={
            measure === 'sales'
              ? (v) => formatMinor(String(Math.round(v)), currency, locale)
              : (v) => count.format(v)
          }
          formatTick={measure === 'sales' ? (v) => compactNumber(v / exp) : compactNumber}
          labels={{
            viewAsTable: t('chart.table'),
            viewAsChart: t('chart.chart'),
            dateColumn: t('chart.date'),
          }}
        />
      )}
    </DashboardCard>
  );
}
