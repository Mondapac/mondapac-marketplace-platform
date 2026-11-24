import {
  ActivityTable,
  Badge,
  ChartEmpty,
  ChartSkeleton,
  DashboardCard,
  DashboardSlot,
  DefinitionHint,
  GridItem,
  KpiCard,
  StatCardSkeleton,
  formatCount,
  type ActivityColumn,
  type DashboardSource,
  type GridLayout,
  type IconName,
  type StatDeltaProps,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
  CategoryDonut,
  RevenueChartCard,
  StatusBar,
  type Measure,
  type RevenueDay,
} from './kpi-charts.tsx';
import {
  kpiDayLabel,
  kpiDelta,
  kpiMoney,
  kpiRate,
  guardDelta,
  kpiSentiment,
  PERIOD_KEY,
  minorToMajor,
  minutesBetween,
} from './kpi-format.ts';
import {
  KPI_SELLERS_PERMISSION,
  allowedOf,
  type KpiAllowed,
  type AdminKpis,
  type FinanceKpis,
  type HealthCount,
  type KpiDelta,
  type KpiAnswer,
  type KpiPeriodId,
  type KpiResult,
  type KpiSection,
  type OperationsKpis,
  type SameDayShare,
  type TopSellerRow,
} from './kpi-types.ts';

type Source = DashboardSource<KpiResult | null>;

/** The four headline cards: four across on desktop, two by two on a tablet and wide phone. */
const KPI_LAYOUT: GridLayout = { span: 3, tabletSpan: 6, phoneSpan: 6, mobileOrder: 'kpi' };
const CHART_LAYOUT: GridLayout = { span: 8, tabletSpan: 12 };
const WIDE_LAYOUT: GridLayout = { span: 12 };

/** What one section of the read is for a card: left out, failed (in place), or its figures. */
type Part<K> =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ok'; readonly kpis: K; readonly value: AdminKpis };

/**
 * A refused section (null) is left out, never shown as an error; one that failed, or a whole read
 * that failed for a session that holds the key, is an in-place error.
 */
function part<K>(
  result: KpiAnswer,
  allowed: boolean,
  pick: (value: AdminKpis) => KpiSection<K> | null,
): Part<K> {
  if (!allowed) return { kind: 'hidden' };
  if (result.kind === 'error') return { kind: 'failed' };
  const section = pick(result.value);
  if (section === null) return { kind: 'hidden' };
  if (section.status === 'error') return { kind: 'failed' };
  return { kind: 'ok', kpis: section.kpis, value: result.value };
}

const financeOf = (result: KpiAnswer, allowed: KpiAllowed) =>
  part<FinanceKpis>(result, allowed.money, (v) => v.finance);
const operationsOf = (result: KpiAnswer, allowed: KpiAllowed) =>
  part<OperationsKpis>(result, allowed.orders, (v) => v.operations);

function Slot({
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

function useStalled() {
  return useTranslations('dashboard')('error.card');
}

function Skeleton({ icon, label }: { readonly icon: IconName; readonly label: string }) {
  return <StatCardSkeleton as="div" icon={icon} label={label} stalledLabel={useStalled()} />;
}

function CardSkeleton({
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
function useDelta(period: KpiPeriodId) {
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

function useRange() {
  const locale = useLocale();
  return (value: AdminKpis): string | null =>
    value.period === null
      ? null
      : `${kpiDayLabel(value.period.current.from, locale)} - ${kpiDayLabel(value.period.current.to, locale)}`;
}

function useCommon(id: 'gmv' | 'orders' | 'net' | 'aov') {
  const t = useTranslations('dashboard.kpis');
  const label = t(`${id}.label`);
  return {
    label,
    definition: t(`def.${id}`),
    definitionLabel: t('def.what', { name: label }),
  };
}

const TRENDS = (series: readonly string[], currency: string, locale: string): number[] =>
  series.map((amount) => minorToMajor(amount, currency, locale));

function GmvCard({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const delta = useDelta(period);
  const common = useCommon('gmv');
  const base = {
    ...common,
    icon: 'wallet' as const,
    tile: 'blue' as const,
    href: '/orders',
    highlight: true,
  };
  return (
    <Slot
      source={source}
      layout={KPI_LAYOUT}
      fallback={<Skeleton icon="wallet" label={common.label} />}
    >
      {(result) => {
        const finance = financeOf(result, allowed);
        if (finance.kind === 'hidden') return null;
        if (finance.kind === 'failed') {
          return <KpiCard {...base} scope={t(`compared.${PERIOD_KEY[period]}`)} error={stalled} />;
        }
        const { current, deltas, series, currency } = finance.kpis;
        const change = delta(
          guardDelta(deltas.gmvWithTax, current.gmvWithTax, finance.kpis.previous.gmvWithTax),
          'percent',
          'better',
        );
        return (
          <KpiCard
            {...base}
            value={kpiMoney(current.gmvWithTax, locale)}
            scope={t('gmv.scope', { excl: kpiMoney(current.gmvWithoutTax, locale) })}
            {...(change === undefined ? {} : { delta: change })}
            sparkline={TRENDS(
              series.map((point) => point.gmvWithTax),
              currency,
              locale,
            )}
          />
        );
      }}
    </Slot>
  );
}

function OrdersCard({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const delta = useDelta(period);
  const common = useCommon('orders');
  const base = {
    ...common,
    icon: 'package' as const,
    tile: 'aqua' as const,
    href: '/orders',
    scope: t('orders.scope'),
  };
  return (
    <Slot
      source={source}
      layout={KPI_LAYOUT}
      fallback={<Skeleton icon="package" label={common.label} />}
    >
      {(result) => {
        const operations = operationsOf(result, allowed);
        if (operations.kind === 'hidden') return null;
        if (operations.kind === 'failed') return <KpiCard {...base} error={stalled} />;
        const { current, deltas, series } = operations.kpis;
        const change = delta(
          guardDelta(deltas.ordersPaid, current.ordersPaid, operations.kpis.previous.ordersPaid),
          'percent',
          'better',
        );
        return (
          <KpiCard
            {...base}
            value={formatCount(current.ordersPaid, false, locale)}
            {...(change === undefined ? {} : { delta: change })}
            sparkline={series.map((point) => point.ordersPaid)}
          />
        );
      }}
    </Slot>
  );
}

/**
 * Mondapac net revenue. Until the Market has a week of matching ledger the API sends no figure and
 * the card says so; a total with a part not recorded is never drawn as a number (the card names
 * what is missing); a failed net read is an error in place while the GMV card still shows.
 */
function NetCard({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const delta = useDelta(period);
  const common = useCommon('net');
  const base = {
    ...common,
    icon: 'receipt' as const,
    tile: 'violet' as const,
    href: '/orders',
  };
  return (
    <Slot
      source={source}
      layout={KPI_LAYOUT}
      fallback={<Skeleton icon="receipt" label={common.label} />}
    >
      {(result) => {
        const finance = financeOf(result, allowed);
        if (finance.kind === 'hidden') return null;
        const scope = t('net.scope-empty');
        if (finance.kind === 'failed') {
          return <KpiCard {...base} scope={scope} error={t('net.failed')} />;
        }
        const { net } = finance.kpis;
        if (net === null) return <KpiCard {...base} scope={scope} error={t('net.failed')} />;
        const { current } = net;
        if (!net.readiness.ready || current === null) {
          return <KpiCard {...base} scope={scope} note={t('net.not-ready')} />;
        }
        if (current.total.status === 'partial') {
          const missing = current.total.missing
            .map((name) =>
              t.has(`component.${name}`) ? t(`component.${name}` as 'component.commission') : name,
            )
            .join(', ');
          return <KpiCard {...base} scope={scope} note={t('net.partial', { missing })} />;
        }
        const rate = net.takeRate.current;
        const rateScope =
          rate === null || rate.status === 'no-sales' || rate.rateBp === undefined
            ? t('net.scope-none')
            : rate.status === 'complete'
              ? t('net.scope', { rate: kpiRate(rate.rateBp, locale) })
              : t('net.scope-partial', {
                  rate: kpiRate(rate.rateBp, locale),
                  basis: (rate.basis ?? [])
                    .map((name) =>
                      t.has(`component.${name}`)
                        ? t(`component.${name}` as 'component.commission')
                        : name,
                    )
                    .join(', '),
                });
        const before = net.previous?.total.status === 'complete' ? net.previous.total.amount : null;
        const change = delta(
          guardDelta(net.deltas.total, current.total.amount, before),
          'percent',
          'better',
        );
        return (
          <KpiCard
            {...base}
            value={kpiMoney(current.total.amount, locale)}
            scope={rateScope}
            {...(change === undefined ? {} : { delta: change })}
          />
        );
      }}
    </Slot>
  );
}

function AovCard({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const delta = useDelta(period);
  const common = useCommon('aov');
  const base = {
    ...common,
    icon: 'tag' as const,
    tile: 'slate' as const,
    href: '/orders',
    scope: t('aov.scope'),
  };
  return (
    <Slot
      source={source}
      layout={KPI_LAYOUT}
      fallback={<Skeleton icon="tag" label={common.label} />}
    >
      {(result) => {
        const finance = financeOf(result, allowed);
        if (finance.kind === 'hidden') return null;
        if (finance.kind === 'failed') return <KpiCard {...base} error={stalled} />;
        const { current, deltas } = finance.kpis;
        if (current.averageOrderWithTax === null) {
          return <KpiCard {...base} note={t('aov.none')} />;
        }
        const change = delta(
          guardDelta(
            deltas.averageOrderWithTax,
            current.averageOrderWithTax,
            finance.kpis.previous.averageOrderWithTax,
          ),
          'percent',
          'better',
        );
        return (
          <KpiCard
            {...base}
            value={kpiMoney(current.averageOrderWithTax, locale)}
            {...(change === undefined ? {} : { delta: change })}
          />
        );
      }}
    </Slot>
  );
}

function RevenueChart({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const range = useRange();
  const frame = { id: 'dash-gmv', title: t('chart.title') };
  return (
    <Slot source={source} layout={CHART_LAYOUT} fallback={<CardSkeleton {...frame} height={240} />}>
      {(result) => {
        const finance = financeOf(result, allowed);
        const operations = operationsOf(result, allowed);
        if (finance.kind === 'hidden' && operations.kind === 'hidden') return null;
        if (finance.kind !== 'ok' && operations.kind !== 'ok') {
          return <DashboardCard {...frame} error={stalled} />;
        }
        const measures: Measure[] = [
          ...(finance.kind === 'ok' ? (['gmv'] as const) : []),
          ...(operations.kind === 'ok' ? (['orders'] as const) : []),
          ...(finance.kind === 'ok' ? (['refunded'] as const) : []),
        ];
        const failed: Measure[] = [
          ...(finance.kind === 'failed' ? (['gmv'] as const) : []),
          ...(operations.kind === 'failed' ? (['orders'] as const) : []),
        ];
        const currency = finance.kind === 'ok' ? finance.kpis.currency : '';
        const days = (rows: 'series' | 'previousSeries'): RevenueDay[] => {
          const money = finance.kind === 'ok' ? finance.kpis[rows] : null;
          const count = operations.kind === 'ok' ? operations.kpis[rows] : null;
          const orders = new Map((count ?? []).map((point) => [point.day, point.ordersPaid]));
          const base = money ?? count ?? [];
          return base.map((point, index) => {
            const gmv = money?.[index];
            const ordersToday = orders.get(point.day);
            return {
              label: kpiDayLabel(point.day, locale),
              ...(gmv === undefined
                ? {}
                : {
                    gmv: minorToMajor(gmv.gmvWithTax, currency, locale),
                    refunded: minorToMajor(gmv.refundedWithTax, currency, locale),
                  }),
              ...(ordersToday === undefined ? {} : { orders: ordersToday }),
            };
          });
        };
        const value =
          finance.kind === 'ok'
            ? finance.value
            : operations.kind === 'ok'
              ? operations.value
              : null;
        const refreshed = [value?.finance, value?.operations]
          .map((section) => (section?.status === 'ok' ? section.refreshedAt : null))
          .filter((at): at is string => at !== null && at !== undefined)
          .sort()
          .at(-1);
        const minutes =
          value === null || refreshed === undefined
            ? null
            : minutesBetween(refreshed, value.generatedAt);
        const scope = [
          value === null ? null : range(value),
          t('market-time'),
          minutes === null ? t('no-data-yet') : t('updated', { minutes }),
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');
        return (
          <RevenueChartCard
            id={frame.id}
            scope={scope}
            currency={currency}
            locale={locale}
            periodLabel={t(`period.${PERIOD_KEY[period]}`)}
            days={days('series')}
            previousDays={days('previousSeries')}
            measures={measures}
            failed={failed}
            definition={t('def.chart')}
            actionHref="/orders"
          />
        );
      }}
    </Slot>
  );
}

const MIN_ORDERS = 5;

function SalesByCategory({ source, allowed }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const range = useRange();
  const frame = { id: 'dash-top-categories', title: t('categories.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        const categories = part(result, allowed.money, (v) => v.topCategories);
        if (categories.kind === 'hidden') return null;
        if (categories.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const { rows } = categories.kpis;
        const orders = rows.reduce((sum, row) => sum + row.orders, 0);
        const currency = rows[0]?.salesWithTax.currency ?? '';
        const state =
          rows.length === 0 ? 'empty' : orders < MIN_ORDERS ? 'insufficient' : undefined;
        const text = range(categories.value);
        return (
          <DashboardCard
            {...frame}
            scope={text === null ? t('categories.scope') : `${text} · ${t('categories.scope')}`}
            titleAdornment={
              <DefinitionHint
                label={t('def.what', { name: frame.title })}
                definition={t('def.categories')}
              />
            }
          >
            <CategoryDonut
              title={frame.title}
              segments={rows.map((row) => ({
                id: row.categoryId,
                label: row.name ?? t('categories.uncategorised'),
                value: minorToMajor(row.salesWithTax.amountMinor, currency, locale),
              }))}
              currency={currency}
              locale={locale}
              {...(state === undefined ? {} : { state })}
            />
            {state === 'insufficient' ? (
              <p className="mt-2 text-xs text-fg-muted">
                {t('categories.insufficient-hint', { count: MIN_ORDERS })}
              </p>
            ) : null}
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

function Tile({
  label,
  children,
  hint,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly hint?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-line bg-muted p-3">
      <span className="text-xs text-fg-muted">{label}</span>
      {children}
      {hint === undefined ? null : <span className="text-xs text-fg-muted">{hint}</span>}
    </div>
  );
}

const FIGURE = 'text-xl font-semibold tabular-nums text-fg';
const WORDS = 'text-sm font-medium text-fg-secondary';

function SameDayTile({ same }: { readonly same: SameDayShare }) {
  const t = useTranslations('dashboard.kpis.status.same-day');
  const locale = useLocale();
  if (same.status === 'available') {
    return (
      <Tile
        label={t('label')}
        hint={t('of', {
          sameDay: formatCount(same.sameDay, false, locale),
          paid: formatCount(same.paid, false, locale),
        })}
      >
        <span className={FIGURE}>{kpiRate(same.rateBp, locale)}</span>
      </Tile>
    );
  }
  if (same.status === 'not-enough-data') {
    return (
      <Tile
        label={t('label')}
        hint={t('not-enough-hint', { minimum: same.minimum, paid: same.paid })}
      >
        <span className={WORDS}>{t('not-enough')}</span>
      </Tile>
    );
  }
  return (
    <Tile label={t('label')} hint={t('unavailable-hint', { count: same.unknownMethod })}>
      <span className={WORDS}>{t('unavailable')}</span>
    </Tile>
  );
}

function OrdersByStatus({ source, allowed }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const range = useRange();
  const frame = { id: 'dash-orders-status', title: t('status.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        const status = part(result, allowed.orders, (v) => v.ordersByStatus);
        if (status.kind === 'hidden') return null;
        if (status.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const k = status.kpis;
        const operations = status.value.operations;
        const state = k.paid === 0 ? 'empty' : k.paid < MIN_ORDERS ? 'insufficient' : undefined;
        const text = range(status.value);
        return (
          <DashboardCard
            {...frame}
            scope={text === null ? t('status.scope') : `${text} · ${t('status.scope')}`}
            action={{ href: '/orders', label: t('status.action') }}
            titleAdornment={
              <DefinitionHint
                label={t('def.what', { name: frame.title })}
                definition={t('def.status')}
              />
            }
          >
            <div className="flex flex-col gap-3">
              <StatusBar
                title={frame.title}
                locale={locale}
                {...(state === undefined ? {} : { state })}
                items={[
                  {
                    id: 'delivered',
                    label: t('status.delivered'),
                    value: k.delivered,
                    colorKey: 'cat-1',
                  },
                  {
                    id: 'shipped',
                    label: t('status.shipped'),
                    value: k.shipped,
                    colorKey: 'cat-2',
                  },
                  { id: 'to-ship', label: t('status.to-ship'), value: k.toShip, colorKey: 'cat-3' },
                  {
                    id: 'cancelled',
                    label: t('status.cancelled'),
                    value: k.cancelled,
                    colorKey: 'status-danger',
                  },
                  {
                    id: 'refunded',
                    label: t('status.refunded'),
                    value: k.refunded,
                    colorKey: 'status-attention',
                  },
                ]}
              />
              {state === 'insufficient' ? (
                <p className="text-xs text-fg-muted">
                  {t('status.insufficient-hint', { count: MIN_ORDERS })}
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                {operations === null ? null : operations.status === 'ok' ? (
                  <Tile
                    label={t('status.on-time.label')}
                    hint={t('status.on-time.value', {
                      count: formatCount(operations.kpis.current.ordersShipped, false, locale),
                    })}
                  >
                    {operations.kpis.current.onTimeRateBp === null ? (
                      <span className={WORDS}>{t('status.on-time.none')}</span>
                    ) : (
                      <span className={FIGURE}>
                        {kpiRate(operations.kpis.current.onTimeRateBp, locale)}
                      </span>
                    )}
                  </Tile>
                ) : (
                  <Tile label={t('status.on-time.label')}>
                    <span role="alert" className="text-sm text-critical-fg">
                      {stalled}
                    </span>
                  </Tile>
                )}
                <SameDayTile same={k.sameDayShare} />
              </div>
            </div>
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

function HealthRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex items-start justify-between gap-4 border-t border-line-row py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        <span className="text-xs text-fg-muted">{hint}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">{children}</span>
    </li>
  );
}

const Failed = () => {
  const t = useTranslations('dashboard.kpis.health');
  return <span className="max-w-40 text-end text-sm text-critical-fg">{t('failed')}</span>;
};

const Figure = ({ children }: { readonly children: ReactNode }) => (
  <span className="text-lg font-semibold tabular-nums text-fg">{children}</span>
);

function CountFigure({
  count,
  incident,
}: {
  readonly count: HealthCount;
  readonly incident: boolean;
}) {
  const t = useTranslations('dashboard.kpis.health');
  const locale = useLocale();
  if (count.status === 'error') return <Failed />;
  return (
    <>
      <Figure>{formatCount(count.count, false, locale)}</Figure>
      {count.count > 0 ? (
        <Badge tone={incident ? 'critical' : 'attention'}>
          {t(incident ? 'incident' : 'watch')}
        </Badge>
      ) : (
        <Badge tone="success">{t('clear')}</Badge>
      )}
    </>
  );
}

function SupplyHealth({ source, allowed }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const frame = { id: 'dash-market-health', title: t('health.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        if (!allowed.health && !allowed.orders) return null;
        if (result.kind === 'error') return <DashboardCard {...frame} error={stalled} />;
        const { health, operations } = result.value;
        const sellers = allowed.orders ? operations : null;
        if (health === null && sellers === null) return null;
        const count = (n: number) => formatCount(n, false, locale);
        const rows: ReactNode[] = [];
        if (sellers !== null) {
          rows.push(
            <HealthRow key="active" label={t('health.active.label')} hint={t('health.active.hint')}>
              {sellers.status === 'ok' && sellers.kpis.sellersWithOrders !== null ? (
                <Figure>{count(sellers.kpis.sellersWithOrders)}</Figure>
              ) : (
                <Failed />
              )}
            </HealthRow>,
          );
        }
        if (health?.listings) {
          const l = health.listings;
          rows.push(
            <HealthRow
              key="listings"
              label={t('health.listings.label')}
              hint={t('health.listings.hint')}
            >
              {l.status === 'ok' && l.active !== undefined ? (
                <Figure>{count(l.active)}</Figure>
              ) : (
                <Failed />
              )}
            </HealthRow>,
            <HealthRow key="stock" label={t('health.stock.label')} hint={t('health.stock.hint')}>
              {l.status === 'ok' && l.outOfStock !== undefined ? (
                <>
                  <Figure>{count(l.outOfStock)}</Figure>
                  {l.outOfStockRateBp == null ? null : (
                    <span className="text-xs text-fg-muted">
                      {kpiRate(l.outOfStockRateBp, locale)}
                    </span>
                  )}
                </>
              ) : (
                <Failed />
              )}
            </HealthRow>,
          );
        }
        if (health?.certificatesExpiring) {
          const c = health.certificatesExpiring;
          rows.push(
            <HealthRow
              key="expiring"
              label={t('health.expiring.label')}
              hint={t('health.expiring.hint', { days: c.withinDays ?? 30 })}
            >
              {c.status === 'ok' && c.count !== undefined ? (
                <Figure>{count(c.count)}</Figure>
              ) : (
                <Failed />
              )}
            </HealthRow>,
          );
        }
        if (health?.uncertifiedListings) {
          rows.push(
            <HealthRow key="lapsed" label={t('health.lapsed.label')} hint={t('health.lapsed.hint')}>
              <CountFigure count={health.uncertifiedListings} incident />
            </HealthRow>,
          );
        }
        if (health?.sellersAtRisk) {
          rows.push(
            <HealthRow key="risk" label={t('health.risk.label')} hint={t('health.risk.hint')}>
              <CountFigure count={health.sellersAtRisk} incident={false} />
            </HealthRow>,
          );
        }
        if (health?.payoutsOnHold) {
          const h = health.payoutsOnHold;
          rows.push(
            <HealthRow
              key="holds"
              label={t('health.holds.label')}
              hint={
                h.status === 'ok' && h.amount?.status === 'not-available'
                  ? t('health.holds.amount')
                  : t('health.holds.hint')
              }
            >
              {h.status === 'ok' && h.count !== undefined ? (
                <Figure>{count(h.count)}</Figure>
              ) : (
                <Failed />
              )}
            </HealthRow>,
          );
        }
        if (health?.disputeRate) {
          const d = health.disputeRate;
          rows.push(
            <HealthRow
              key="disputes"
              label={t('health.disputes.label')}
              hint={
                d.status === 'ok' &&
                d.disputes !== undefined &&
                d.paidSellerOrders !== undefined &&
                d.paidSellerOrders > 0
                  ? t('health.disputes.hint', {
                      disputes: count(d.disputes),
                      paid: count(d.paidSellerOrders),
                    })
                  : ''
              }
            >
              {d.status === 'ok' ? (
                d.rateBp === null || d.rateBp === undefined || d.paidSellerOrders === 0 ? (
                  <span className={WORDS}>{t('health.disputes.none')}</span>
                ) : (
                  <Figure>{kpiRate(d.rateBp, locale)}</Figure>
                )
              ) : (
                <Failed />
              )}
            </HealthRow>,
          );
        }
        if (rows.length === 0) return null;
        return (
          <DashboardCard
            {...frame}
            scope={t('health.scope')}
            titleAdornment={
              <DefinitionHint
                label={t('def.what', { name: frame.title })}
                definition={t('def.health')}
              />
            }
          >
            <ul aria-label={frame.title} className="flex flex-col">
              {rows}
            </ul>
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

function TopSellers({
  source,
  allowed,
  canOpenSellers,
}: CardProps & { readonly canOpenSellers: boolean }) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const range = useRange();
  const frame = { id: 'dash-top-sellers', title: t('sellers.title') };
  return (
    <Slot source={source} layout={WIDE_LAYOUT} fallback={<CardSkeleton {...frame} height={160} />}>
      {(result) => {
        const sellers = part(result, allowed.money, (v) => v.topSellers);
        if (sellers.kind === 'hidden') return null;
        if (sellers.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const { rows } = sellers.kpis;
        const top = Math.max(
          0,
          ...rows
            .map((row) => minorToMajor(row.gmvWithTax.amountMinor, row.gmvWithTax.currency, locale))
            .filter(Number.isFinite),
        );
        const columns: ActivityColumn<TopSellerRow>[] = [
          {
            id: 'store',
            header: t('sellers.col.store'),
            kind: 'title',
            cell: (row) => {
              const name = row.storeName ?? t('sellers.unnamed');
              const width =
                top > 0
                  ? Math.max(
                      2,
                      (minorToMajor(row.gmvWithTax.amountMinor, row.gmvWithTax.currency, locale) /
                        top) *
                        100,
                    )
                  : 0;
              return (
                <div className="flex flex-col gap-1.5">
                  {canOpenSellers ? (
                    <a
                      className="font-medium text-link underline"
                      href={`/sellers/${encodeURIComponent(row.sellerId)}`}
                    >
                      {name}
                    </a>
                  ) : (
                    <span className="font-medium">{name}</span>
                  )}
                  <span
                    aria-hidden="true"
                    className="block h-1.5 w-full max-w-64 overflow-hidden rounded-full bg-chart-track"
                  >
                    <span
                      className="block h-full rounded-full bg-chart-series"
                      style={{ width: `${width}%` }}
                    />
                  </span>
                </div>
              );
            },
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
        const text = range(sellers.value);
        return (
          <DashboardCard
            {...frame}
            scope={text === null ? t('sellers.scope') : `${text} · ${t('sellers.scope')}`}
            {...(canOpenSellers
              ? { action: { href: '/sellers', label: t('sellers.action') } }
              : {})}
            titleAdornment={
              <DefinitionHint
                label={t('def.what', { name: frame.title })}
                definition={t('def.sellers')}
              />
            }
            flush={rows.length > 0}
          >
            {rows.length === 0 ? (
              <ChartEmpty message={t('sellers.empty')} height={120} />
            ) : (
              <ActivityTable
                caption={frame.title}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.sellerId}
              />
            )}
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

interface CardProps {
  readonly source: Source;
  readonly allowed: KpiAllowed;
  readonly period: KpiPeriodId;
}

/**
 * In place of the figures when the range is refused: one line with the way out. The reason is
 * under the field in the page header, so it is not said twice.
 */
export function InvalidRangeNote({ source }: { readonly source: Source }) {
  const t = useTranslations('dashboard.kpis.range');
  return (
    <DashboardSlot layout={{ span: 12, mobileOrder: 'kpi' }} source={source} fallback={null}>
      {(result) =>
        result === null || result.kind !== 'invalid' ? null : (
          <p className="w-full min-w-0 rounded-lg border border-line bg-surface p-4 text-sm text-fg-secondary">
            {t('choose')}{' '}
            <a className="font-medium text-link underline" href="/?period=30d">
              {t('back')}
            </a>
          </p>
        )
      }
    </DashboardSlot>
  );
}

function Cell({
  wide = false,
  children,
}: {
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`flex min-w-0 empty:hidden lg:flex-1 ${wide ? 'md:col-span-2 lg:col-span-1' : ''}`}
    >
      {children}
    </div>
  );
}

/**
 * The KPI part of the admin dashboard as items of its DashboardGrid: four headline cards (GMV,
 * seller orders paid, Mondapac net revenue, average order), the revenue chart with its measure
 * switch, sales by category, orders by status, supply and health, and the top sellers. All read
 * the one KPI answer; each is present only when its section is (a refused section is left out),
 * and a failed section says so in place, never as a zero.
 */
export function KpiItems({
  source,
  period,
  permissionKeys,
  before,
}: {
  readonly source: Source;
  readonly period: KpiPeriodId;
  readonly permissionKeys: readonly string[];
  /** Items placed after the chart in the same row (the work queue). */
  readonly before?: ReactNode;
}) {
  const allowed = allowedOf(permissionKeys);
  const props = { source, allowed, period };
  return (
    <>
      <InvalidRangeNote source={source} />
      <GmvCard {...props} />
      <OrdersCard {...props} />
      <NetCard {...props} />
      <AovCard {...props} />
      <RevenueChart {...props} />
      {before}
      <GridItem span={12}>
        {/* Cards that are absent leave no hole: the rest share the row (and the tablet's two columns). */}
        <div className="grid w-full min-w-0 gap-4 md:grid-cols-2 lg:flex">
          <Cell>
            <SalesByCategory {...props} />
          </Cell>
          <Cell>
            <OrdersByStatus {...props} />
          </Cell>
          <Cell wide>
            <SupplyHealth {...props} />
          </Cell>
        </div>
      </GridItem>
      <TopSellers {...props} canOpenSellers={new Set(permissionKeys).has(KPI_SELLERS_PERMISSION)} />
    </>
  );
}
