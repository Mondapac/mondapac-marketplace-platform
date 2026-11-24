import {
  Badge,
  BarList,
  ChartSkeleton,
  DashboardCard,
  DashboardSlot,
  EmptyState,
  KpiCard,
  Ring,
  StatCardSkeleton,
  formatCount,
  type BadgeTone,
  type BarListItem,
  type DashboardSource,
  type GridLayout,
  type IconName,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstant } from '../../catalog/format.ts';
import type { CategoryTree } from '../../catalog/products-list-types.ts';
import type { NextPayout } from '../../earnings/payout-types.ts';
import type { HealthBand, OwnHealth } from '../../performance/types.ts';
import { formatMinor } from '../../price/money.ts';
import type { Widget } from '../types.ts';
import type { SellerKpiSources } from './load.ts';
import { SalesChartCard, type ChartDay } from './sales-chart-card.tsx';
import type { Period, SellerKpis, SellerNetEarnings } from './types.ts';
import { deltasOf } from './view.ts';

type Source<T> = DashboardSource<Widget<T> | null>;

const BAND_TONE: Record<HealthBand, BadgeTone> = {
  healthy: 'success',
  'at-risk': 'attention',
  unhealthy: 'critical',
};

const BLOCK_REASONS = [
  'below-minimum',
  'awaiting-approval',
  'account-not-ready',
  'cooling-off',
  'payouts-paused',
  'zone-missing',
  'second-factor-required',
] as const;

/** The four headline cards: four across on desktop, two by two on a tablet and a phone. */
const KPI_LAYOUT: GridLayout = { span: 3, tabletSpan: 6, phoneSpan: 6, mobileOrder: 'kpi' };

const dayLabel = (day: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

const okOf = <T,>(widget: Widget<T> | null): T | null =>
  widget?.kind === 'ok' ? widget.value : null;

function useStalled() {
  return useTranslations('dashboard')('error.card');
}

function CardSkeleton({ icon, label }: { readonly icon: IconName; readonly label: string }) {
  return <StatCardSkeleton as="div" icon={icon} label={label} stalledLabel={useStalled()} />;
}

/** Sales (the highlighted card) and Seller orders paid: both from the KPI read. */
function SalesCard({
  source,
  period,
}: {
  readonly source: Source<SellerKpis>;
  readonly period: Period;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  const scope = t(`scope.${period}`);
  return (
    <DashboardSlot
      layout={KPI_LAYOUT}
      source={source}
      fallback={<CardSkeleton icon="wallet" label={t('card.sales')} />}
    >
      {(widget) => {
        const kpis = okOf(widget);
        const common = {
          icon: 'wallet' as const,
          tile: 'blue' as const,
          label: t('card.sales'),
          definition: t('def.sales'),
          definitionLabel: t('def.what', { name: t('card.sales') }),
          scope,
          href: '/earnings',
          highlight: true,
        };
        if (kpis === null) return <KpiCard {...common} error={stalled} />;
        const delta = deltasOf(kpis.current, kpis.previous, t(`compared.${period}`));
        return (
          <KpiCard
            {...common}
            value={formatMinor(kpis.current.salesInclTax, kpis.currency, locale)}
            delta={delta.sales}
            sparkline={kpis.series.map((day) => Number(day.salesInclTax))}
          />
        );
      }}
    </DashboardSlot>
  );
}

function OrdersCard({
  source,
  period,
}: {
  readonly source: Source<SellerKpis>;
  readonly period: Period;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  return (
    <DashboardSlot
      layout={KPI_LAYOUT}
      source={source}
      fallback={<CardSkeleton icon="clipboard" label={t('card.orders')} />}
    >
      {(widget) => {
        const kpis = okOf(widget);
        const common = {
          icon: 'clipboard' as const,
          tile: 'aqua' as const,
          label: t('card.orders'),
          definition: t('def.orders'),
          definitionLabel: t('def.what', { name: t('card.orders') }),
          scope: t(`scope.${period}`),
          href: '/orders',
        };
        if (kpis === null) return <KpiCard {...common} error={stalled} />;
        const delta = deltasOf(kpis.current, kpis.previous, t(`compared.${period}`));
        return (
          <KpiCard
            {...common}
            value={formatCount(kpis.current.orders, false, locale)}
            delta={delta.orders}
            sparkline={kpis.series.map((day) => day.orders)}
          />
        );
      }}
    </DashboardSlot>
  );
}

/**
 * Net earnings: what the seller keeps after commission, without GST, from the ledger. Until the
 * Market has a week of matching ledger the API sends no figure and the card says when it will
 * come; a partial figure is never drawn as a total.
 */
function NetEarningsCard({
  source,
  period,
}: {
  readonly source: Source<SellerNetEarnings>;
  readonly period: Period;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  return (
    <DashboardSlot
      layout={KPI_LAYOUT}
      source={source}
      fallback={<CardSkeleton icon="receipt" label={t('card.earnings')} />}
    >
      {(widget) => {
        if (widget === null) return null;
        const earnings = okOf(widget);
        const common = {
          icon: 'receipt' as const,
          tile: 'violet' as const,
          label: t('card.earnings'),
          definition: t('def.earnings'),
          definitionLabel: t('def.what', { name: t('card.earnings') }),
          href: '/earnings',
        };
        if (earnings === null) {
          return <KpiCard {...common} scope={t(`scope.${period}`)} error={stalled} />;
        }
        if (!earnings.ready || earnings.netEarnings === null) {
          return <KpiCard {...common} scope={t('earnings.scope')} note={t('earnings.not-ready')} />;
        }
        return (
          <KpiCard
            {...common}
            value={formatMinor(earnings.netEarnings, earnings.currency, locale)}
            scope={`${t(`scope.${period}`)} · ${t('earnings.scope')}`}
          />
        );
      }}
    </DashboardSlot>
  );
}

/** Next payout: the estimate and the day it is looked at, or in words why nothing is on its way. */
function NextPayoutCard({ source }: { readonly source: Source<NextPayout> }) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  return (
    <DashboardSlot
      layout={KPI_LAYOUT}
      source={source}
      fallback={<CardSkeleton icon="clock" label={t('card.payout')} />}
    >
      {(widget) => {
        if (widget === null) return null;
        const next = okOf(widget);
        const common = {
          icon: 'clock' as const,
          tile: 'slate' as const,
          label: t('card.payout'),
          definition: t('def.payout'),
          definitionLabel: t('def.what', { name: t('card.payout') }),
          href: '/earnings',
        };
        if (next === null) return <KpiCard {...common} scope="" error={stalled} />;
        const slot =
          next.slotAt === null ? null : shortInstant(next.slotAt, locale, next.zone ?? undefined);
        const reason =
          next.blockReason === null
            ? null
            : (BLOCK_REASONS as readonly string[]).includes(next.blockReason)
              ? next.blockReason
              : 'unknown';
        if (reason !== null) {
          return (
            <KpiCard
              {...common}
              note={t(`payout.block.${reason}` as 'payout.block.unknown')}
              scope={slot === null ? t('payout.no-slot') : t('payout.looked-at', { when: slot })}
            />
          );
        }
        if (next.estimatedAmount === null) {
          return (
            <KpiCard
              {...common}
              note={t('payout.nothing')}
              scope={slot === null ? t('payout.no-slot') : t('payout.looked-at', { when: slot })}
            />
          );
        }
        return (
          <KpiCard
            {...common}
            value={formatMinor(
              next.estimatedAmount.amountMinor,
              next.estimatedAmount.currency,
              locale,
            )}
            badge={<Badge tone="info">{t('payout.estimated')}</Badge>}
            scope={slot === null ? t('payout.no-slot') : t('payout.scheduled', { when: slot })}
          />
        );
      }}
    </DashboardSlot>
  );
}

const CHART_LAYOUT: GridLayout = { span: 8, tabletSpan: 12 };

function SalesChart({
  source,
  period,
}: {
  readonly source: Source<SellerKpis>;
  readonly period: Period;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  const frame = { id: 'dash-kpi-sales', title: t('chart.title'), scope: t(`scope.${period}`) };
  return (
    <DashboardSlot
      layout={CHART_LAYOUT}
      source={source}
      fallback={
        <DashboardCard {...frame}>
          <ChartSkeleton />
        </DashboardCard>
      }
    >
      {(widget) => {
        const kpis = okOf(widget);
        if (kpis === null) return <DashboardCard {...frame} error={stalled} />;
        const updated =
          kpis.refreshedAt === null ? null : shortInstant(kpis.refreshedAt, locale, kpis.timezone);
        const scope = [
          t(`scope.${period}`),
          t('chart.zone', { zone: kpis.timezone }),
          updated === null ? null : t('chart.updated', { time: updated }),
        ]
          .filter((part) => part !== null)
          .join(' · ');
        const days = (rows: SellerKpis['series']): ChartDay[] =>
          rows.map((d) => ({
            label: dayLabel(d.day, locale),
            sales: Number(d.salesInclTax),
            orders: d.orders,
          }));
        return (
          <SalesChartCard
            id={frame.id}
            scope={scope}
            currency={kpis.currency}
            locale={locale}
            periodLabel={t(`scope.${period}`)}
            days={days(kpis.series)}
            previousDays={days(kpis.previousSeries)}
          />
        );
      }}
    </DashboardSlot>
  );
}

const SIDE_LAYOUT: GridLayout = { span: 4, tabletSpan: 6 };

/**
 * The best-selling part of the dashboard. There is no per-product sales read yet (FE-178), so the
 * card ranks the seller's categories, which the KPI endpoint does send.
 */
function TopCategories({
  source,
  categories,
}: {
  readonly source: Source<SellerKpis>;
  readonly categories: DashboardSource<CategoryTree | null>;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  const frame = {
    id: 'dash-kpi-categories',
    title: t('categories.title'),
    scope: t('categories.scope'),
  };
  const fallback = (
    <DashboardCard {...frame}>
      <ChartSkeleton height={160} />
    </DashboardCard>
  );
  return (
    <DashboardSlot layout={SIDE_LAYOUT} source={source} fallback={fallback}>
      {(widget) => {
        const kpis = okOf(widget);
        if (kpis === null) return <DashboardCard {...frame} error={stalled} />;
        return (
          <DashboardSlot source={categories} fallback={fallback}>
            {(tree) => {
              const names = new Map((tree?.categories ?? []).map((c) => [c.id, c.name]));
              const items: BarListItem[] = kpis.topCategories.map((row, index) => ({
                id: row.categoryId,
                label:
                  tree === null
                    ? t('categories.numbered', { n: index + 1 })
                    : (names.get(row.categoryId) ?? t('categories.other')),
                value: Number(row.netSalesInclTax),
                display: formatMinor(row.netSalesInclTax, kpis.currency, locale),
                detail: t('categories.detail', { orders: row.orders, units: row.units }),
              }));
              return (
                <DashboardCard {...frame}>
                  {items.length === 0 ? (
                    <EmptyState size="compact" icon="inbox" title={t('categories.empty')} />
                  ) : (
                    <BarList label={t('categories.title')} items={items} />
                  )}
                </DashboardCard>
              );
            }}
          </DashboardSlot>
        );
      }}
    </DashboardSlot>
  );
}

/** Store health out of 100 as a ring, with the scored measures beside it. */
function StoreHealth({ source }: { readonly source: Source<OwnHealth> }) {
  const t = useTranslations('dashboard.kpi');
  const tm = useTranslations('performance.metric');
  const stalled = useStalled();
  const frame = {
    id: 'dash-kpi-health',
    title: t('health.title'),
    scope: t('health.scope'),
    action: { href: '/performance', label: t('health.action') },
  };
  return (
    <DashboardSlot
      layout={SIDE_LAYOUT}
      source={source}
      fallback={
        <DashboardCard {...frame}>
          <ChartSkeleton height={140} />
        </DashboardCard>
      }
    >
      {(widget) => {
        if (widget === null) return null;
        const health = okOf(widget);
        if (health === null) return <DashboardCard {...frame} error={stalled} />;
        const card = health.current;
        let body: ReactNode;
        if (card === null || card.kind !== 'scored' || card.score === null) {
          body = (
            <p className="text-sm text-fg-muted">
              {t(card?.kind === 'new' ? 'health.new' : 'health.none')}
            </p>
          );
        } else {
          const scored = card.metrics.filter((m) => m.kind === 'scored' && m.score !== undefined);
          body = (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Ring
                label={t('health.title')}
                percent={card.score}
                display={String(card.score)}
                caption={
                  card.band === null
                    ? t('health.out-of')
                    : `${t('health.out-of')} · ${t(`health.band.${card.band}`)}`
                }
                size={128}
                emptyLabel={t('health.none')}
              />
              <ul aria-label={t('health.measures')} className="flex min-w-40 flex-1 flex-col gap-2">
                {scored.map((m) => (
                  <li key={m.metric} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-fg-secondary">
                      {tm(`${m.metric}.name` as 'late-ready.name')}
                    </span>
                    <span className="flex items-center gap-2 font-medium tabular-nums text-fg">
                      {m.score}
                      {m.band == null ? null : (
                        <Badge tone={BAND_TONE[m.band]}>{tm(`band.${m.band}`)}</Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="w-full text-xs text-fg-muted">
                {t('health.orders', { count: card.orders })}
              </p>
            </div>
          );
        }
        return <DashboardCard {...frame}>{body}</DashboardCard>;
      }}
    </DashboardSlot>
  );
}

/**
 * The KPI part of the seller dashboard as items of its DashboardGrid: the four headline cards
 * (Sales, Seller orders paid, Net earnings, Next payout), the sales chart with its measure
 * switch, the best-selling categories and the store health. Every block reads on its own and
 * says so in place when its read fails; sales figures never show a zero for a failed read.
 */
export function KpiItems({
  sources,
  period,
}: {
  readonly sources: SellerKpiSources;
  readonly period: Period;
}) {
  return (
    <>
      <SalesCard source={sources.kpis} period={period} />
      <OrdersCard source={sources.kpis} period={period} />
      {sources.netEarnings === null ? null : (
        <NetEarningsCard source={sources.netEarnings} period={period} />
      )}
      {sources.nextPayout === null ? null : <NextPayoutCard source={sources.nextPayout} />}
      <SalesChart source={sources.kpis} period={period} />
      <StoreHealth source={sources.health} />
      <TopCategories source={sources.kpis} categories={sources.categories} />
    </>
  );
}
