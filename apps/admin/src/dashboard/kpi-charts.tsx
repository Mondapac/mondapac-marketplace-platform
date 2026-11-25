'use client';

import {
  ChartEmpty,
  DashboardCard,
  DefinitionHint,
  DonutChart,
  LineAreaChart,
  PeriodSelector,
  ShareBar,
  compactNumber,
  type ChartPoint,
  type ColorKey,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { kpiMajor } from './kpi-format.ts';

// The charts of the admin dashboard that need a formatter. A server component cannot pass a
// function to a chart, so these are client components that build the formatter from plain data.

/** The measures of the revenue chart; each is a series the KPI read already sends. */
export const MEASURES = ['gmv', 'orders', 'refunded'] as const;
export type Measure = (typeof MEASURES)[number];

/** Tall enough to sit level with the work queue card beside it. */
const CHART_HEIGHT = 360;

/** One day of the revenue chart. A measure whose section is missing or failed is left out. */
export interface RevenueDay {
  /** The x label as shown ("21 Nov"). */
  readonly label: string;
  /** Major units. */
  readonly gmv?: number;
  readonly orders?: number;
  /** Major units. */
  readonly refunded?: number;
  /**
   * The Orders list of the day (ordersHref, from the day's yyyy-mm-dd) and the link's name. The
   * GMV and Orders measures link a point to it; Refunded does not (refunds fall on another day).
   */
  readonly link?: { readonly href: string; readonly label: string };
}

/**
 * The revenue chart card: the measure switch (a native select on a phone), the line against the
 * previous period, "View as table", the "?" definition, and the two empty states: nothing sold,
 * and too few days to draw a line. A measure whose read failed says so in place.
 */
export function RevenueChartCard({
  id,
  scope,
  currency,
  locale,
  periodLabel,
  days,
  previousDays,
  measures,
  failed,
  definition,
  actionHref,
}: {
  readonly id: string;
  readonly scope: string;
  readonly currency: string;
  readonly locale: string;
  readonly periodLabel: string;
  readonly days: readonly RevenueDay[];
  readonly previousDays: readonly RevenueDay[];
  /** The measures that have data, in switch order; at least one. */
  readonly measures: readonly Measure[];
  /** The measures whose read failed. */
  readonly failed: readonly Measure[];
  readonly definition: string;
  readonly actionHref: string;
}) {
  const t = useTranslations('dashboard.kpis');
  const [chosen, setChosen] = useState<Measure>(measures[0]!);
  const measure = measures.includes(chosen) ? chosen : measures[0]!;
  const money = measure !== 'orders';
  const count = new Intl.NumberFormat(locale);
  const value = (day: RevenueDay) => day[measure] ?? 0;
  const bothEmpty = [...days, ...previousDays].every((day) => !(value(day) > 0));
  const insufficient = days.length < 2;
  const linked = measure !== 'refunded';
  const points = (rows: readonly RevenueDay[], links = false): ChartPoint[] =>
    rows.map((day) => ({
      label: day.label,
      value: value(day),
      ...(links && linked && day.link !== undefined
        ? { href: day.link.href, linkLabel: day.link.label }
        : {}),
    }));
  const name = t(`chart.measure.${measure}`);
  const currentEmpty = days.every((day) => !(value(day) > 0));
  return (
    <DashboardCard
      id={id}
      title={t('chart.title')}
      scope={scope}
      stackedHeader
      headerRight={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {measures.length > 1 ? (
            <PeriodSelector
              label={t('chart.measure.label')}
              options={measures.map((m) => ({ id: m, label: t(`chart.measure.${m}`) }))}
              value={measure}
              onChange={(next) => {
                if ((MEASURES as readonly string[]).includes(next)) setChosen(next as Measure);
              }}
            />
          ) : null}
          <a
            href={actionHref}
            className="inline-flex min-h-11 items-center whitespace-nowrap text-sm font-medium text-link underline lg:min-h-0"
          >
            {t('chart.action')}
          </a>
        </div>
      }
      titleAdornment={
        <DefinitionHint label={t('def.what', { name: t('chart.title') })} definition={definition} />
      }
    >
      <div className="flex flex-col gap-3">
        {failed.map((m) => (
          <p key={m} role="alert" className="text-sm text-critical-fg">
            {t('chart.measure-failed', { measure: t(`chart.measure.${m}`) })}
          </p>
        ))}
        {bothEmpty ? (
          <ChartEmpty message={t('chart.empty')} height={CHART_HEIGHT} />
        ) : currentEmpty ? (
          <ChartEmpty message={t('chart.empty-current')} height={CHART_HEIGHT} />
        ) : insufficient ? (
          <ChartEmpty
            message={t('chart.insufficient')}
            hint={t('chart.insufficient-hint')}
            height={CHART_HEIGHT}
          />
        ) : (
          <LineAreaChart
            title={t('chart.alt', { measure: name, period: periodLabel })}
            points={points(days, true)}
            compare={points(previousDays)}
            seriesLabel={t('chart.this')}
            compareLabel={t('chart.previous')}
            formatValue={money ? (v) => kpiMajor(v, currency, locale) : (v) => count.format(v)}
            formatTick={compactNumber}
            height={CHART_HEIGHT}
            labels={{
              viewAsTable: t('chart.table'),
              viewAsChart: t('chart.chart'),
              dateColumn: t('chart.date'),
              openPoint: t('chart.open-point'),
            }}
          />
        )}
      </div>
    </DashboardCard>
  );
}

/** Sales by category: the donut (five named and Other) with its own table toggle. */
export function CategoryDonut({
  title,
  segments,
  currency,
  locale,
  state,
}: {
  readonly title: string;
  readonly segments: readonly {
    readonly id: string;
    readonly label: string;
    /** Major units. */
    readonly value: number;
  }[];
  readonly currency: string;
  readonly locale: string;
  readonly state?: 'empty' | 'insufficient';
}) {
  const t = useTranslations('dashboard.kpis.categories');
  return (
    <DonutChart
      title={title}
      segments={segments}
      formatValue={(v) => kpiMajor(v, currency, locale)}
      formatCentre={(v) =>
        `${new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(v)}`
      }
      otherLabel={t('other')}
      totalLabel={t('total')}
      {...(state === undefined ? {} : { state })}
      emptyLabels={{ empty: t('empty'), insufficient: t('insufficient') }}
      labels={{
        viewAsTable: t('table'),
        viewAsChart: t('chart'),
        categoryColumn: t('col.name'),
        valueColumn: t('col.sales'),
        shareColumn: t('col.share'),
      }}
    />
  );
}

/** The paid orders by where they are now: one bar, a legend with counts, and the table toggle. */
export function StatusBar({
  title,
  items,
  locale,
  state,
}: {
  readonly title: string;
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: number;
    readonly colorKey: ColorKey;
    /** The Orders list of this status (ordersHref) and the link's name; none: not a link. */
    readonly href?: string;
    readonly linkLabel?: string;
  }[];
  readonly locale: string;
  readonly state?: 'empty' | 'insufficient';
}) {
  const t = useTranslations('dashboard.kpis.status');
  const count = new Intl.NumberFormat(locale);
  return (
    <ShareBar
      title={title}
      items={items}
      formatValue={(v) => count.format(v)}
      otherLabel={t('other')}
      {...(state === undefined ? {} : { state })}
      emptyLabels={{ empty: t('empty'), insufficient: t('insufficient') }}
      labels={{
        viewAsTable: t('table'),
        viewAsChart: t('chart'),
        categoryColumn: t('col.status'),
        valueColumn: t('col.orders'),
        shareColumn: t('col.share'),
      }}
    />
  );
}
