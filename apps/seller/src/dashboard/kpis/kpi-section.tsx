import {
  Badge,
  BarList,
  ChartEmpty,
  ChartSkeleton,
  DashboardCard,
  DashboardSlot,
  EmptyState,
  GridItem,
  InsightCard,
  KpiCard,
  Ring,
  StatCardSkeleton,
  formatCount,
  type BadgeTone,
  type BarListItem,
  type DashboardSource,
  type GridLayout,
  type IconName,
  type InsightTable,
  type StatDeltaProps,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstant } from '../../catalog/format.ts';
import type { CategoryTree } from '../../catalog/products-list-types.ts';
import type { NextPayout } from '../../earnings/payout-types.ts';
import type { HealthBand, OwnHealth } from '../../performance/types.ts';
import { PAYOUT_ACCOUNT_PATH } from '../../payout/types.ts';
import { formatMinor } from '../../price/money.ts';
import type { Widget } from '../types.ts';
import type { SellerKpiSources } from './load.ts';
import { SalesChartCard, type ChartDay } from './sales-chart-card.tsx';
import type { SellerKpis, SellerNetEarnings, ShownPeriod } from './types.ts';
import { deltasOf, MIN_BASE_ORDERS } from './view.ts';

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
/** With no figures (a refused range) the payout card is one of the three cards of the first row. */
const REFUSED_PAYOUT_LAYOUT: GridLayout = {
  span: 4,
  tabletSpan: 6,
  phoneSpan: 12,
  mobileOrder: 'kpi',
  align: 'start',
};
const KPI_LAYOUT: GridLayout = { span: 3, tabletSpan: 6, phoneSpan: 6, mobileOrder: 'kpi' };

const dayLabel = (day: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

const okOf = <T,>(widget: Widget<T> | null): T | null =>
  widget?.kind === 'ok' ? widget.value : null;

/** Where the seller fixes why a payout is not on its way; the earnings page when there is no fix page. */
const BLOCK_FIX: Record<string, string> = {
  'account-not-ready': PAYOUT_ACCOUNT_PATH,
  'cooling-off': PAYOUT_ACCOUNT_PATH,
  'second-factor-required': '/account/security',
};

/** A change with no figure ("n/a") says why: the previous period had too few orders. */
/** With no sales in the period there is nothing to compare: say so instead of a red -100.0%. */
function noSalesOr(delta: StatDeltaProps, kpis: SellerKpis, text: string): StatDeltaProps {
  return kpis.current.orders === 0 && delta.value !== 'n/a'
    ? { ...delta, value: text, direction: 'flat', sentiment: 'neutral', plain: true }
    : delta;
}

function withHint(delta: StatDeltaProps, hint: string): StatDeltaProps {
  return delta.value === 'n/a' ? { ...delta, hint } : delta;
}

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
  readonly period: ShownPeriod;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  const scope = `${t(`scope.${period}`)} · ${t('sales.basis')}`;
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
            delta={noSalesOr(withHint(delta.sales, t('delta.na')), kpis, t('delta.no-sales'))}
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
  readonly period: ShownPeriod;
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
            delta={noSalesOr(withHint(delta.orders, t('delta.na')), kpis, t('delta.no-sales'))}
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
  readonly period: ShownPeriod;
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
          return (
            <KpiCard {...common} scope={t(`scope.${period}`)} note={t('earnings.not-ready')} />
          );
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
function NextPayoutCard({
  source,
  refused,
}: {
  readonly source: Source<NextPayout>;
  /** The range is refused: it is not part of a four-card strip, so it sits beside the other cards at their width and keeps its own height. */
  readonly refused: boolean;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  return (
    <DashboardSlot
      layout={refused ? REFUSED_PAYOUT_LAYOUT : KPI_LAYOUT}
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
              href={BLOCK_FIX[reason] ?? common.href}
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
  readonly period: ShownPeriod;
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
          period === 'custom'
            ? `${dayLabel(kpis.period.current.from, locale)} - ${dayLabel(kpis.period.current.to, locale)}`
            : t(`scope.${period}`),
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
            period={period}
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
 * The best-selling part of the dashboard. There is no per-product sales read yet (FE-20261124-seller-top-products-per-offer), so the
 * card ranks the seller's categories, which the KPI endpoint does send. With fewer than
 * MIN_BASE_ORDERS paid orders a ranking says nothing, so the card says "not enough data" instead.
 */
function TopCategories({
  source,
  categories,
  period,
}: {
  readonly source: Source<SellerKpis>;
  readonly categories: DashboardSource<CategoryTree | null>;
  readonly period: ShownPeriod;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale();
  const stalled = useStalled();
  const frame = {
    id: 'dash-kpi-categories',
    title: t('categories.title'),
    scope: `${t(`scope.${period}`)} · ${t('categories.basis')}`,
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
              const rows = kpis.topCategories.map((row, index) => ({
                row,
                name:
                  tree === null
                    ? t('categories.numbered', { n: index + 1 })
                    : (names.get(row.categoryId) ?? t('categories.other')),
                money: formatMinor(row.netSalesInclTax, kpis.currency, locale),
              }));
              const items: BarListItem[] = rows.map(({ row, name, money }) => ({
                id: row.categoryId,
                label: name,
                value: Number(row.netSalesInclTax),
                display: money,
                detail: t('categories.detail', { orders: row.orders, units: row.units }),
              }));
              const table: InsightTable = {
                caption: t('categories.table'),
                columns: [
                  { id: 'name', header: t('categories.col.name') },
                  { id: 'sales', header: t('categories.col.sales'), align: 'end' },
                  { id: 'orders', header: t('categories.col.orders'), align: 'end' },
                  { id: 'units', header: t('categories.col.units'), align: 'end' },
                ],
                rows: rows.map(({ row, name, money }) => [
                  name,
                  money,
                  String(row.orders),
                  String(row.units),
                ]),
              };
              const insufficient = kpis.current.orders > 0 && kpis.current.orders < MIN_BASE_ORDERS;
              const none = items.length === 0 || kpis.current.orders === 0;
              return (
                <InsightCard
                  {...frame}
                  definition={t('def.categories')}
                  definitionLabel={t('def.what', { name: t('categories.title') })}
                  viewAsTable={t('chart.table')}
                  viewAsChart={t('chart.chart')}
                  chart={
                    none ? (
                      <EmptyState size="compact" icon="inbox" title={t('categories.empty')} />
                    ) : insufficient ? (
                      <ChartEmpty
                        height={160}
                        message={t('categories.insufficient')}
                        hint={t('categories.insufficient-hint', { count: MIN_BASE_ORDERS })}
                      />
                    ) : (
                      <BarList label={t('categories.title')} items={items} />
                    )
                  }
                  {...(none || insufficient ? {} : { table })}
                />
              );
            }}
          </DashboardSlot>
        );
      }}
    </DashboardSlot>
  );
}

/**
 * Store health out of 100 as a ring, with the scored measures beside it and as a table. A store
 * that is still New (too few orders to score) or has no score says so as "not enough data".
 */
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
        const common = {
          ...frame,
          definition: t('def.health'),
          definitionLabel: t('def.what', { name: t('health.title') }),
          viewAsTable: t('chart.table'),
          viewAsChart: t('chart.chart'),
        };
        if (card === null || card.kind !== 'scored' || card.score === null) {
          return (
            <InsightCard
              {...common}
              chart={
                <ChartEmpty
                  height={140}
                  message={t('health.insufficient')}
                  hint={t(card?.kind === 'new' ? 'health.new' : 'health.none')}
                />
              }
            />
          );
        }
        const scored = card.metrics.filter((m) => m.kind === 'scored' && m.score !== undefined);
        const table: InsightTable = {
          caption: t('health.table'),
          columns: [
            { id: 'measure', header: t('health.col.measure') },
            { id: 'score', header: t('health.col.score'), align: 'end' },
            { id: 'status', header: t('health.col.status') },
          ],
          rows: scored.map((m) => [
            tm(`${m.metric}.name` as 'late-ready.name'),
            String(m.score),
            m.band == null ? '-' : tm(`band.${m.band}`),
          ]),
        };
        const chart: ReactNode = (
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
        return <InsightCard {...common} chart={chart} table={table} />;
      }}
    </DashboardSlot>
  );
}

/**
 * In place of the figures when the custom range is refused: one line with the way out. The reason
 * is under the field in the page header, so it is not said twice.
 */
function InvalidRangeNote() {
  const t = useTranslations('dashboard.kpi.range');
  return (
    <GridItem span={12} mobileOrder="kpi">
      <p className="w-full min-w-0 rounded-lg border border-line bg-surface p-4 text-sm text-fg-secondary">
        {t('choose')}{' '}
        <a className="whitespace-nowrap font-medium text-link underline" href="/?period=30d">
          {t('back')}
        </a>
      </p>
    </GridItem>
  );
}

/**
 * The KPI part of the seller dashboard as items of its DashboardGrid: the four headline cards
 * (Sales, Orders paid, Net earnings, Next payout), the sales chart with its measure switch, the
 * best-selling categories and the store health. Each group is present only when its read was
 * started (its key). Every block reads on its own and says so in place when its read fails; sales
 * figures never show a zero for a failed read.
 */
export function KpiItems({
  sources,
  period,
}: {
  readonly sources: SellerKpiSources;
  readonly period: ShownPeriod;
}) {
  return (
    <>
      {sources.refused ? <InvalidRangeNote /> : null}
      {sources.kpis === null ? null : (
        <>
          <SalesCard source={sources.kpis} period={period} />
          <OrdersCard source={sources.kpis} period={period} />
        </>
      )}
      {sources.netEarnings === null ? null : (
        <NetEarningsCard source={sources.netEarnings} period={period} />
      )}
      {sources.nextPayout === null ? null : (
        <NextPayoutCard source={sources.nextPayout} refused={sources.refused} />
      )}
      {sources.kpis === null ? null : <SalesChart source={sources.kpis} period={period} />}
      <StoreHealth source={sources.health} />
      {sources.kpis === null || sources.categories === null ? null : (
        <TopCategories source={sources.kpis} categories={sources.categories} period={period} />
      )}
    </>
  );
}
