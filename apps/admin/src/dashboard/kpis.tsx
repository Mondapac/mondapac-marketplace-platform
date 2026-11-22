import {
  ActivityTable,
  BarList,
  ChartCardSkeleton,
  ChartEmpty,
  DashboardCard,
  DashboardSlot,
  Funnel,
  LineAreaChart,
  StatCard,
  StatCardSkeleton,
  StatGrid,
  formatCount,
  type ActivityColumn,
  type ChartPoint,
  type IconName,
  type PeriodOption,
  type StatCardProps,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { KpiPeriodSwitch } from './kpi-period-switch.tsx';
import {
  kpiDayLabel,
  kpiDelta,
  kpiMajor,
  kpiMoney,
  kpiRate,
  kpiSentiment,
  minorToMajor,
  minutesBetween,
} from './kpi-format.ts';
import {
  KPI_PERIODS,
  type AdminKpiSource,
  type AdminKpis,
  type KpiDelta,
  type KpiPeriod,
  type KpiResult,
  type TopSellerRow,
  KPI_MONEY_PERMISSION,
  KPI_ORDERS_PERMISSION,
  KPI_SELLERS_PERMISSION,
} from './kpi-types.ts';

const PERIOD_KEY: Record<KpiPeriod, string> = {
  today: 'today',
  '7d': 'days7',
  '30d': 'days30',
  month: 'month',
};

type Delta = NonNullable<StatCardProps['delta']>;

function useSkeletonText() {
  const t = useTranslations();
  return { slowLabel: t('route.slow'), stalledLabel: t('dashboard.error.card') };
}

/** One figure's change line, or none when the period has no previous one to compare with. */
function useDelta(period: KpiPeriod) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const comparedWith = t(`compared.${PERIOD_KEY[period]}`);
  return (delta: KpiDelta, kind: 'percent' | 'points', higherIs: 'better' | 'worse'): Delta => ({
    value: kpiDelta(delta, kind, locale),
    direction: delta.direction,
    sentiment: kpiSentiment(delta, higherIs),
    comparedWith,
  });
}

interface CardSpec {
  readonly id: string;
  readonly icon: IconName;
  readonly href: string;
}

const CARDS: Record<string, CardSpec> = {
  gmv: { id: 'gmv', icon: 'wallet', href: '/orders' },
  net: { id: 'net', icon: 'receipt', href: '/orders' },
  aov: { id: 'aov', icon: 'tag', href: '/orders' },
  refunded: { id: 'refunded', icon: 'receipt', href: '/refunds' },
  orders: { id: 'orders', icon: 'package', href: '/orders' },
  cancel: { id: 'cancel', icon: 'ban', href: '/orders' },
  onTime: { id: 'onTime', icon: 'clock', href: '/shipments' },
  refunds: { id: 'refunds', icon: 'inbox', href: '/refunds' },
};

function FinanceCards({
  kpis,
  period,
}: {
  readonly kpis: NonNullable<AdminKpis['finance']> & { readonly status: 'ok' };
  readonly period: KpiPeriod;
}) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const delta = useDelta(period);
  const { kpis: data } = kpis;
  const { current, deltas, series, currency } = data;
  const trend = (pick: (point: (typeof series)[number]) => string) =>
    series.map((point) => minorToMajor(pick(point), currency, locale));
  return (
    <>
      <StatCard
        {...CARDS.gmv!}
        label={t('gmv.label')}
        value={kpiMoney(current.gmvWithTax, locale)}
        scope={t('gmv.scope', { excl: kpiMoney(current.gmvWithoutTax, locale) })}
        delta={delta(deltas.gmvWithTax, 'percent', 'better')}
        sparkline={trend((point) => point.gmvWithTax)}
      />
      <StatCard
        {...CARDS.net!}
        label={t('net.label')}
        value={kpiMoney(current.netSalesWithTax, locale)}
        scope={t('net.scope')}
        delta={delta(deltas.netSalesWithTax, 'percent', 'better')}
      />
      <StatCard
        {...CARDS.aov!}
        label={t('aov.label')}
        value={
          current.averageOrderWithTax === null ? '-' : kpiMoney(current.averageOrderWithTax, locale)
        }
        scope={t('aov.scope')}
        delta={delta(deltas.averageOrderWithTax, 'percent', 'better')}
      />
      <StatCard
        {...CARDS.refunded!}
        label={t('refunded.label')}
        value={kpiMoney(current.refundedWithTax, locale)}
        scope={t('refunded.scope', { rate: kpiRate(current.refundRateBp, locale) })}
        delta={delta(deltas.refundedWithTax, 'percent', 'worse')}
        sparkline={trend((point) => point.refundedWithTax)}
      />
    </>
  );
}

function OperationsCards({
  kpis,
  period,
}: {
  readonly kpis: NonNullable<AdminKpis['operations']> & { readonly status: 'ok' };
  readonly period: KpiPeriod;
}) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const delta = useDelta(period);
  const { current, deltas, series } = kpis.kpis;
  return (
    <>
      <StatCard
        {...CARDS.orders!}
        label={t('orders.label')}
        value={formatCount(current.ordersPaid, false, locale)}
        scope={t('orders.scope')}
        delta={delta(deltas.ordersPaid, 'percent', 'better')}
        sparkline={series.map((point) => point.ordersPaid)}
      />
      <StatCard
        {...CARDS.cancel!}
        label={t('cancel.label')}
        value={kpiRate(current.cancelRateBp, locale)}
        scope={t('cancel.scope', { count: formatCount(current.ordersCancelled, false, locale) })}
        delta={delta(deltas.cancelRateBp, 'points', 'worse')}
      />
      <StatCard
        {...CARDS.onTime!}
        label={t('on-time.label')}
        value={kpiRate(current.onTimeRateBp, locale)}
        scope={t('on-time.scope', { count: formatCount(current.ordersShipped, false, locale) })}
        delta={delta(deltas.onTimeRateBp, 'points', 'better')}
      />
      <StatCard
        {...CARDS.refunds!}
        label={t('refunds.label')}
        value={formatCount(current.refunds, false, locale)}
        scope={t('refunds.scope')}
        delta={delta(deltas.refunds, 'percent', 'worse')}
        sparkline={series.map((point) => point.refunds)}
      />
    </>
  );
}

/** A section whose read failed: its cards say so in place, the other section still shows. */
function ErrorCards({ ids }: { readonly ids: readonly (keyof typeof CARDS)[] }) {
  const t = useTranslations('dashboard');
  return (
    <>
      {ids.map((id) => (
        <StatCard
          key={id}
          {...CARDS[id]!}
          label={t(`kpis.${id === 'onTime' ? 'on-time' : id}.label`)}
          value="-"
          scope=""
          error={t('error.card')}
        />
      ))}
    </>
  );
}

function GmvChart({
  finance,
  period,
  value,
}: {
  readonly finance: NonNullable<AdminKpis['finance']> & { readonly status: 'ok' };
  readonly period: KpiPeriod;
  readonly value: AdminKpis;
}) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const { series, previousSeries, currency } = finance.kpis;
  const point = (row: (typeof series)[number]): ChartPoint => ({
    label: kpiDayLabel(row.day, locale),
    value: minorToMajor(row.gmvWithTax, currency, locale),
  });
  const points = series.map(point);
  const empty = points.every((p) => !(p.value > 0));
  const periodNote = value.period
    ? `${kpiDayLabel(value.period.current.from, locale)} - ${kpiDayLabel(value.period.current.to, locale)}`
    : undefined;
  return (
    <DashboardCard
      id="dash-gmv"
      title={t('chart.title')}
      {...(periodNote === undefined ? {} : { scope: periodNote })}
      action={{ href: '/orders', label: t('chart.action') }}
    >
      {empty ? (
        <ChartEmpty message={t('chart.empty')} />
      ) : (
        <LineAreaChart
          title={t('chart.alt', { period: t(`period.${PERIOD_KEY[period]}`) })}
          points={points}
          compare={previousSeries.map(point)}
          seriesLabel={t('chart.this')}
          compareLabel={t('chart.previous')}
          formatValue={(v) => kpiMajor(v, currency, locale)}
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

function OrderFlow({
  operations,
  value,
}: {
  readonly operations: NonNullable<AdminKpis['operations']> & { readonly status: 'ok' };
  readonly value: AdminKpis;
}) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const { current } = operations.kpis;
  const count = (n: number) => formatCount(n, false, locale);
  const periodNote = value.period
    ? `${kpiDayLabel(value.period.current.from, locale)} - ${kpiDayLabel(value.period.current.to, locale)}`
    : undefined;
  return (
    <DashboardCard
      id="dash-order-flow"
      title={t('flow.title')}
      scope={periodNote === undefined ? t('flow.scope') : `${periodNote} · ${t('flow.scope')}`}
      action={{ href: '/orders', label: t('flow.action') }}
    >
      {current.ordersPaid === 0 ? (
        <ChartEmpty message={t('flow.empty')} height={120} />
      ) : (
        <div className="flex flex-col gap-4">
          <Funnel
            label={t('flow.title')}
            showShare={false}
            steps={[
              {
                id: 'paid',
                label: t('flow.paid'),
                value: current.ordersPaid,
                display: count(current.ordersPaid),
              },
              {
                id: 'shipped',
                label: t('flow.shipped'),
                value: current.ordersShipped,
                display: count(current.ordersShipped),
              },
              {
                id: 'delivered',
                label: t('flow.delivered'),
                value: current.ordersDelivered,
                display: count(current.ordersDelivered),
              },
            ]}
          />
          <p className="text-sm text-fg-muted">
            {t('flow.leaks', {
              cancelled: count(current.ordersCancelled),
              cancelRate: kpiRate(current.cancelRateBp, locale),
              refunds: count(current.refunds),
            })}
          </p>
        </div>
      )}
    </DashboardCard>
  );
}

function TopSellers({
  topSellers,
  value,
  canOpenSellers,
}: {
  readonly canOpenSellers: boolean;
  readonly topSellers: NonNullable<AdminKpis['topSellers']> & { readonly status: 'ok' };
  readonly value: AdminKpis;
}) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const columns: ActivityColumn<TopSellerRow>[] = [
    {
      id: 'store',
      header: t('sellers.col.store'),
      kind: 'title',
      cell: (row) =>
        canOpenSellers ? (
          <a
            className="font-medium text-link underline"
            href={`/sellers/${encodeURIComponent(row.sellerId)}`}
          >
            {row.storeName ?? t('sellers.unnamed')}
          </a>
        ) : (
          <span className="font-medium">{row.storeName ?? t('sellers.unnamed')}</span>
        ),
    },
    {
      id: 'gmv',
      header: t('sellers.col.gmv'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => kpiMoney(row.gmvWithTax, locale),
    },
    {
      id: 'orders',
      header: t('sellers.col.orders'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => formatCount(row.ordersPaid, false, locale),
    },
    {
      id: 'on-time',
      header: t('sellers.col.on-time'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => kpiRate(row.onTimeRateBp, locale),
    },
    {
      id: 'refunds',
      header: t('sellers.col.refunds'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => kpiRate(row.refundRateBp, locale),
    },
  ];
  const { rows } = topSellers.kpis;
  const periodNote = value.period
    ? `${kpiDayLabel(value.period.current.from, locale)} - ${kpiDayLabel(value.period.current.to, locale)}`
    : undefined;
  return (
    <DashboardCard
      id="dash-top-sellers"
      title={t('sellers.title')}
      scope={
        periodNote === undefined ? t('sellers.scope') : `${periodNote} · ${t('sellers.scope')}`
      }
      {...(canOpenSellers ? { action: { href: '/sellers', label: t('sellers.action') } } : {})}
      flush
    >
      {rows.length === 0 ? (
        <ChartEmpty message={t('sellers.empty')} height={120} />
      ) : (
        <ActivityTable
          caption={t('sellers.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.sellerId}
        />
      )}
    </DashboardCard>
  );
}

function TopCategories({
  topCategories,
  value,
}: {
  readonly topCategories: NonNullable<AdminKpis['topCategories']> & { readonly status: 'ok' };
  readonly value: AdminKpis;
}) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const { rows } = topCategories.kpis;
  const periodNote = value.period
    ? `${kpiDayLabel(value.period.current.from, locale)} - ${kpiDayLabel(value.period.current.to, locale)}`
    : undefined;
  return (
    <DashboardCard
      id="dash-top-categories"
      title={t('categories.title')}
      scope={
        periodNote === undefined
          ? t('categories.scope')
          : `${periodNote} · ${t('categories.scope')}`
      }
    >
      {rows.length === 0 ? (
        <ChartEmpty message={t('categories.empty')} height={120} />
      ) : (
        <BarList
          label={t('categories.title')}
          items={rows.map((row) => ({
            id: row.categoryId,
            label: row.name ?? t('categories.other'),
            value: Number(row.salesWithTax.amountMinor),
            display: kpiMoney(row.salesWithTax, locale),
            detail: t('categories.orders', { count: row.orders }),
          }))}
        />
      )}
    </DashboardCard>
  );
}

function Strip({
  result,
  period,
  keys,
}: {
  readonly result: KpiResult | null;
  readonly period: KpiPeriod;
  readonly keys: ReadonlySet<string>;
}) {
  const t = useTranslations('dashboard.kpis');
  const tErr = useTranslations('dashboard');
  const options: PeriodOption[] = KPI_PERIODS.map((id) => ({
    id,
    label: t(`period.${PERIOD_KEY[id]}`),
  }));
  if (result === null) return null;
  const value = result.kind === 'ok' ? result.value : null;
  const refreshed = [value?.operations, value?.finance]
    .map((section) => (section?.status === 'ok' ? section.refreshedAt : null))
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  const minutes =
    value === null || refreshed === undefined ? null : minutesBetween(refreshed, value.generatedAt);
  const note = [
    t(`compared.${PERIOD_KEY[period]}`),
    t('market-time'),
    minutes === null ? t('no-data-yet') : t('updated', { minutes }),
  ].join(' · ');
  const hidden = value !== null && value.operations === null && value.finance === null;
  if (hidden) return null;
  return (
    <section aria-labelledby="dash-kpis" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="dash-kpis" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <KpiPeriodSwitch label={t('period.label')} options={options} value={period} note={note} />
      </div>
      <StatGrid label={t('title')}>
        {value === null ? (
          <ErrorCards
            ids={[
              ...(keys.has(KPI_MONEY_PERMISSION)
                ? (['gmv', 'net', 'aov', 'refunded'] as const)
                : []),
              ...(keys.has(KPI_ORDERS_PERMISSION)
                ? (['orders', 'cancel', 'onTime', 'refunds'] as const)
                : []),
            ]}
          />
        ) : (
          <>
            {value.finance === null ? null : value.finance.status === 'ok' ? (
              <FinanceCards kpis={value.finance} period={period} />
            ) : (
              <ErrorCards ids={['gmv', 'net', 'aov', 'refunded']} />
            )}
            {value.operations === null ? null : value.operations.status === 'ok' ? (
              <OperationsCards kpis={value.operations} period={period} />
            ) : (
              <ErrorCards ids={['orders', 'cancel', 'onTime', 'refunds']} />
            )}
          </>
        )}
      </StatGrid>
      {value?.finance?.status === 'ok' ? (
        <GmvChart finance={value.finance} period={period} value={value} />
      ) : null}
      {value?.topSellers?.status === 'ok' ? (
        <TopSellers
          topSellers={value.topSellers}
          value={value}
          canOpenSellers={keys.has(KPI_SELLERS_PERMISSION)}
        />
      ) : value?.topSellers?.status === 'error' ? (
        <DashboardCard id="dash-top-sellers" title={t('sellers.title')} error={tErr('error.card')}>
          {null}
        </DashboardCard>
      ) : null}
      {value?.topCategories?.status === 'ok' ? (
        <TopCategories topCategories={value.topCategories} value={value} />
      ) : value?.topCategories?.status === 'error' ? (
        <DashboardCard
          id="dash-top-categories"
          title={t('categories.title')}
          error={tErr('error.card')}
        >
          {null}
        </DashboardCard>
      ) : null}
      {value?.operations?.status === 'ok' ? (
        <OrderFlow operations={value.operations} value={value} />
      ) : value?.operations?.status === 'error' ? (
        <DashboardCard id="dash-order-flow" title={t('flow.title')} error={tErr('error.card')}>
          {null}
        </DashboardCard>
      ) : null}
    </section>
  );
}

/**
 * The admin KPI strip of the home page (dashboards upgrade phase 5): up to eight figures with
 * their change and trend, then the GMV chart against the previous period. A section the session
 * holds no key for is absent; one that failed says so in place. Streams in with its own read.
 */
export function AdminKpiStrip({
  source,
  period,
  permissionKeys,
}: {
  readonly source: AdminKpiSource;
  readonly period: KpiPeriod;
  readonly permissionKeys: readonly string[];
}) {
  const keys = new Set(permissionKeys);
  const money = keys.has(KPI_MONEY_PERMISSION);
  const orders = keys.has(KPI_ORDERS_PERMISSION);
  const skeletonIds = [
    ...(money ? (['gmv', 'net', 'aov', 'refunded'] as const) : []),
    ...(orders ? (['orders', 'cancel', 'onTime', 'refunds'] as const) : []),
  ];
  const t = useTranslations('dashboard.kpis');
  const { slowLabel, stalledLabel } = useSkeletonText();
  return (
    <DashboardSlot
      source={source}
      fallback={
        <div className="flex flex-col gap-3">
          <StatGrid label={t('title')}>
            {skeletonIds.map((id) => (
              <StatCardSkeleton
                key={id}
                icon={CARDS[id]!.icon}
                label={t(`${id === 'onTime' ? 'on-time' : id}.label`)}
                stalledLabel={stalledLabel}
              />
            ))}
          </StatGrid>
          {money ? (
            <ChartCardSkeleton
              id="dash-gmv"
              title={t('chart.title')}
              slowLabel={slowLabel}
              stalledLabel={stalledLabel}
            />
          ) : null}
          {money ? (
            <ChartCardSkeleton
              id="dash-top-sellers"
              title={t('sellers.title')}
              slowLabel={slowLabel}
              stalledLabel={stalledLabel}
            />
          ) : null}
          {money ? (
            <ChartCardSkeleton
              id="dash-top-categories"
              title={t('categories.title')}
              slowLabel={slowLabel}
              stalledLabel={stalledLabel}
            />
          ) : null}
        </div>
      }
    >
      {(result) => <Strip result={result} period={period} keys={keys} />}
    </DashboardSlot>
  );
}
