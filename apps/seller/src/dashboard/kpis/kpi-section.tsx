import {
  Badge,
  BarList,
  ChartEmpty,
  ChartSkeleton,
  DashboardCard,
  DashboardSlot,
  EmptyState,
  LineAreaChart,
  StatCard,
  StatCardSkeleton,
  StatGrid,
  compactNumber,
  formatCount,
  type BadgeTone,
  type BarListItem,
  type ChartPoint,
  type DashboardSource,
  type IconName,
  type StatCardProps,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstant } from '../../catalog/format.ts';
import type { CategoryTree } from '../../catalog/products-list-types.ts';
import type { HealthBand, OwnHealth } from '../../performance/types.ts';
import { exponentOf, formatMinor } from '../../price/money.ts';
import type { Widget } from '../types.ts';
import type { SellerKpiSources } from './load.ts';
import { PeriodSwitch } from './period-switch.tsx';
import { PERIODS, type Period, type SellerKpis } from './types.ts';
import { deltasOf, percent } from './view.ts';

type Source<T> = DashboardSource<Widget<T> | null>;

const BAND_TONE: Record<HealthBand, BadgeTone> = {
  healthy: 'success',
  'at-risk': 'attention',
  unhealthy: 'critical',
};

const dayLabel = (day: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

const okOf = <T,>(widget: Widget<T> | null): T | null =>
  widget?.kind === 'ok' ? widget.value : null;

function useStalled() {
  const t = useTranslations('dashboard');
  return t('error.card');
}

const CARDS: readonly { readonly key: string; readonly icon: IconName }[] = [
  { key: 'sales', icon: 'wallet' },
  { key: 'orders', icon: 'receipt' },
  { key: 'aov', icon: 'tag' },
  { key: 'refunded', icon: 'arrow-left' },
  { key: 'refund-rate', icon: 'sliders' },
  { key: 'on-time', icon: 'clock' },
  { key: 'units', icon: 'package' },
  { key: 'cancelled', icon: 'ban' },
];

function Strip({
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
      source={source}
      fallback={
        <StatGrid label={t('strip')}>
          {CARDS.map((card) => (
            <StatCardSkeleton
              key={card.key}
              icon={card.icon}
              label={t(`card.${card.key}`)}
              stalledLabel={stalled}
            />
          ))}
        </StatGrid>
      }
    >
      {(widget) => {
        const kpis = okOf(widget);
        const scope = t(`scope.${period}`);
        const compared = t(`compared.${period}`);
        const base = (
          key: string,
          href: string,
        ): Pick<StatCardProps, 'label' | 'scope' | 'href'> => ({
          label: t(`card.${key}`),
          scope,
          href,
        });
        if (kpis === null) {
          return (
            <StatGrid label={t('strip')}>
              {CARDS.map((card) => (
                <StatCard
                  key={card.key}
                  icon={card.icon}
                  value="-"
                  error={stalled}
                  {...base(card.key, '/orders')}
                />
              ))}
            </StatGrid>
          );
        }
        const { current, previous, currency } = kpis;
        const money = (minor: string | null) =>
          minor === null ? '-' : formatMinor(minor, currency, locale);
        const delta = deltasOf(current, previous, compared);
        const spark = kpis.series.map((day) => Number(day.salesInclTax));
        return (
          <StatGrid label={t('strip')}>
            <StatCard
              icon="wallet"
              value={money(current.salesInclTax)}
              delta={delta.sales}
              sparkline={spark}
              {...base('sales', '/earnings')}
            />
            <StatCard
              icon="clipboard"
              value={formatCount(current.orders, false, locale)}
              delta={delta.orders}
              {...base('orders', '/orders')}
            />
            <StatCard
              icon="tag"
              value={money(current.averageOrderValue)}
              delta={delta.averageOrderValue}
              {...base('aov', '/orders')}
            />
            <StatCard
              icon="wallet"
              value={money(current.refundedInclTax)}
              delta={delta.refunded}
              {...base('refunded', '/orders')}
            />
            <StatCard
              icon="clipboard"
              value={percent(current.refundRateBps)}
              delta={delta.refundRate}
              {...base('refund-rate', '/orders')}
            />
            <StatCard
              icon="clock"
              value={percent(current.shippedOnTimeBps)}
              delta={delta.onTime}
              {...base('on-time', '/orders')}
              scope={t('scope.on-time')}
            />
            <StatCard
              icon="inbox"
              value={formatCount(current.units, false, locale)}
              delta={delta.units}
              {...base('units', '/orders')}
            />
            <StatCard
              icon="clipboard"
              value={formatCount(current.ordersCancelled, false, locale)}
              delta={delta.cancelled}
              {...base('cancelled', '/orders')}
            />
          </StatGrid>
        );
      }}
    </DashboardSlot>
  );
}

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
        const exp = 10 ** exponentOf(kpis.currency);
        const updated =
          kpis.refreshedAt === null ? null : shortInstant(kpis.refreshedAt, locale, kpis.timezone);
        const scope = [
          t(`scope.${period}`),
          t('chart.zone', { zone: kpis.timezone }),
          updated === null ? null : t('chart.updated', { time: updated }),
        ]
          .filter((part) => part !== null)
          .join(' · ');
        const points: ChartPoint[] = kpis.series.map((d) => ({
          label: dayLabel(d.day, locale),
          value: Number(d.salesInclTax),
        }));
        const compare: ChartPoint[] = kpis.previousSeries.map((d) => ({
          label: dayLabel(d.day, locale),
          value: Number(d.salesInclTax),
        }));
        const empty = kpis.current.orders === 0 && kpis.previous.orders === 0;
        return (
          <DashboardCard {...frame} scope={scope}>
            {empty ? (
              <ChartEmpty message={t('chart.empty')} />
            ) : (
              <LineAreaChart
                title={t('chart.alt', { period: t(`scope.${period}`) })}
                points={points}
                compare={compare}
                seriesLabel={t('chart.series')}
                compareLabel={t('chart.compare')}
                formatValue={(v) => formatMinor(String(Math.round(v)), kpis.currency, locale)}
                formatTick={(v) => compactNumber(v / exp)}
                labels={{
                  viewAsTable: t('chart.table'),
                  viewAsChart: t('chart.chart'),
                  dateColumn: t('chart.date'),
                }}
              />
            )}
          </DashboardCard>
        );
      }}
    </DashboardSlot>
  );
}

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
  return (
    <DashboardSlot
      source={source}
      fallback={
        <DashboardCard {...frame}>
          <ChartSkeleton height={160} />
        </DashboardCard>
      }
    >
      {(widget) => {
        const kpis = okOf(widget);
        if (kpis === null) return <DashboardCard {...frame} error={stalled} />;
        return (
          <DashboardSlot
            source={categories}
            fallback={
              <DashboardCard {...frame}>
                <ChartSkeleton height={160} />
              </DashboardCard>
            }
          >
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

function StoreHealth({ source }: { readonly source: Source<OwnHealth> }) {
  const t = useTranslations('dashboard.kpi');
  const stalled = useStalled();
  const frame = {
    id: 'dash-kpi-health',
    title: t('health.title'),
    action: { href: '/performance', label: t('health.action') },
  };
  return (
    <DashboardSlot
      source={source}
      fallback={
        <DashboardCard {...frame}>
          <ChartSkeleton height={120} />
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
          body = (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-3xl font-semibold text-fg">
                {card.score}
                <span className="text-base font-normal text-fg-muted"> {t('health.out-of')}</span>
              </span>
              {card.band === null ? null : (
                <Badge tone={BAND_TONE[card.band]}>{t(`health.band.${card.band}`)}</Badge>
              )}
              <span className="text-sm text-fg-muted">
                {t('health.orders', { count: card.orders })}
              </span>
            </div>
          );
        }
        return <DashboardCard {...frame}>{body}</DashboardCard>;
      }}
    </DashboardSlot>
  );
}

/**
 * The KPI part of the seller dashboard (dashboards upgrade, phase 6): the period switch, the
 * eight-card strip with the change against the previous period, the sales chart, the top
 * categories and the store health. Every block reads on its own and says so in place when its
 * read fails; sales figures never show a zero for a failed read.
 */
export function KpiSection({
  sources,
  period,
}: {
  readonly sources: SellerKpiSources;
  readonly period: Period;
}) {
  const t = useTranslations('dashboard.kpi');
  const options = PERIODS.map((id) => ({ id, label: t(`period.${id}`) }));
  return (
    <section aria-label={t('title')} className="flex flex-col gap-4">
      <PeriodSwitch
        label={t('period.label')}
        options={options}
        value={period}
        note={t(`compared.${period}`)}
      >
        <Strip source={sources.kpis} period={period} />
        <SalesChart source={sources.kpis} period={period} />
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <TopCategories source={sources.kpis} categories={sources.categories} />
          <StoreHealth source={sources.health} />
        </div>
      </PeriodSwitch>
    </section>
  );
}
