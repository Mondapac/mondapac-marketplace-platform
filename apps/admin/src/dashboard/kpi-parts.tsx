import {
  ChartSkeleton,
  DashboardCard,
  DashboardSlot,
  StatCardSkeleton,
  type DashboardSource,
  type GridLayout,
  type IconName,
  type StatDeltaProps,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { kpiDayLabel, kpiDelta, kpiSentiment, PERIOD_KEY } from './kpi-format.ts';
import type {
  AdminKpis,
  KpiAllowed,
  KpiAnswer,
  KpiDelta,
  KpiPeriodId,
  KpiResult,
  KpiSection,
} from './kpi-types.ts';

// The pieces every KPI card of the admin dashboard shares (kpis.tsx, kpi-phase2.tsx): the one read,
// how a section becomes a card state, the skeletons and the change line.

export type Source = DashboardSource<KpiResult | null>;

export interface CardProps {
  readonly source: Source;
  readonly allowed: KpiAllowed;
  readonly period: KpiPeriodId;
}

/** What one section of the read is for a card: left out, failed (in place), or its figures. */
export type Part<K> =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ok'; readonly kpis: K; readonly value: AdminKpis };

/**
 * A refused section (null, or absent from an older answer) is left out, never shown as an error;
 * one that failed, or a whole read that failed for a session that holds the key, is an in-place
 * error.
 */
export function part<K>(
  result: KpiAnswer,
  allowed: boolean,
  pick: (value: AdminKpis) => KpiSection<K> | null | undefined,
): Part<K> {
  if (!allowed) return { kind: 'hidden' };
  if (result.kind === 'error') return { kind: 'failed' };
  const section = pick(result.value);
  if (section === null || section === undefined) return { kind: 'hidden' };
  if (section.status === 'error') return { kind: 'failed' };
  return { kind: 'ok', kpis: section.kpis, value: result.value };
}

export function Slot({
  source,
  layout,
  fallback,
  children,
}: {
  readonly source: Source;
  readonly layout?: GridLayout;
  readonly fallback: ReactNode;
  readonly children: (result: KpiAnswer) => ReactNode;
}) {
  return (
    <DashboardSlot
      {...(layout === undefined ? {} : { layout })}
      source={source}
      fallback={fallback}
    >
      {(result) => (result === null || result.kind === 'invalid' ? null : children(result))}
    </DashboardSlot>
  );
}

export function useStalled() {
  return useTranslations('dashboard')('error.card');
}

export function Skeleton({ icon, label }: { readonly icon: IconName; readonly label: string }) {
  return <StatCardSkeleton as="div" icon={icon} label={label} stalledLabel={useStalled()} />;
}

export function CardSkeleton({
  id,
  title,
  height,
}: {
  readonly id: string;
  readonly title: string;
  readonly height: number;
}) {
  return (
    <DashboardCard id={id} title={title}>
      <ChartSkeleton height={height} />
    </DashboardCard>
  );
}

/** One figure's change line; "n/a" says why there is no figure. */
export function useDelta(period: KpiPeriodId) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const comparedWith = t(`compared.${PERIOD_KEY[period]}`);
  return (
    delta: KpiDelta | undefined,
    kind: 'percent' | 'points',
    higherIs: 'better' | 'worse',
  ): StatDeltaProps | undefined => {
    if (delta === undefined) return undefined;
    const value = kpiDelta(delta, kind, locale);
    return {
      value,
      direction: delta.direction,
      sentiment: kpiSentiment(delta, higherIs),
      comparedWith,
      ...(value === 'n/a' ? { hint: t('delta.na') } : {}),
    };
  };
}

export function useRange() {
  const locale = useLocale();
  return (value: AdminKpis): string | null =>
    value.period === null
      ? null
      : `${kpiDayLabel(value.period.current.from, locale)} - ${kpiDayLabel(value.period.current.to, locale)}`;
}
