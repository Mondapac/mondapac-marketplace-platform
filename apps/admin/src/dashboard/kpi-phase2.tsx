import {
  Badge,
  BarList,
  ChartEmpty,
  DashboardCard,
  DefinitionHint,
  Gauge,
  KpiCard,
  StatDelta,
  formatCount,
  type BarListItem,
  type StatDeltaProps,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
  guardDelta,
  kpiDayLabel,
  kpiMinor,
  kpiMoney,
  kpiMonthDay,
  kpiMonthName,
  kpiRate,
} from './kpi-format.ts';
import {
  CardSkeleton,
  Skeleton,
  Slot,
  part,
  useDelta,
  useRange,
  useStalled,
  type CardProps,
} from './kpi-parts.tsx';
import type {
  DiscountKindCost,
  FunnelStepKpi,
  MarketTargetKpis,
  ShoppingFunnelKpis,
} from './kpi-types.ts';
import { TargetEditButton } from './target-editor.tsx';

// The dashboards v2 phase 2 cards of the admin dashboard: the month against the Market's target,
// the shopping funnel, abandoned carts, zero-result searches, orders by state and the discount
// cost. Each reads its own section of the one KPI answer: left out without its key (null), an
// in-place error when it failed, and "not enough data" in words when the API holds figures back.

const FIGURE = 'text-xl font-semibold tabular-nums text-fg';
const MUTED = 'text-xs text-fg-muted';

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
      <span className={MUTED}>{label}</span>
      {children}
      {hint === undefined ? null : <span className={MUTED}>{hint}</span>}
    </div>
  );
}

function Hint({ name, definition }: { readonly name: string; readonly definition: string }) {
  const t = useTranslations('dashboard.kpis');
  return <DefinitionHint label={t('def.what', { name })} definition={definition} />;
}

/** "12 of 30 days counted" when the nightly rows do not cover the whole period yet. */
function useCoverage() {
  const t = useTranslations('dashboard.kpis');
  return (recorded: number, days: number): string | null =>
    recorded < days ? t('coverage', { recorded, days }) : null;
}

const joined = (...parts: readonly (string | null)[]): string =>
  parts.filter((text): text is string => text !== null && text !== '').join(' · ');

/** The month to date against the target; the forecast is always labelled an estimate. */
function TargetBody({
  k,
  canEditTarget,
}: {
  readonly k: MarketTargetKpis;
  readonly canEditTarget: boolean;
}) {
  const t = useTranslations('dashboard.kpis.target');
  const locale = useLocale();
  const money = (amount: string) => kpiMinor(amount, k.currency, locale);
  const lastMonth = kpiMonthName(k.lastMonth, locale);
  const monthEnd = kpiMonthDay(k.month, k.daysInMonth, locale);
  const forecast =
    k.forecast.status === 'estimate'
      ? t('forecast', {
          amount: money(k.forecast.amount),
          day: monthEnd,
          month: lastMonth,
          last: money(k.lastMonthTotal),
        })
      : t('forecast-not-enough', {
          days: k.forecast.minimumDays,
          month: lastMonth,
          last: money(k.lastMonthTotal),
        });
  const pace =
    k.paceBp === null ? null : (
      <Badge tone={k.paceBp >= 10000 ? 'success' : 'info'}>
        {t('pace', { rate: kpiRate(k.paceBp, locale) })}
      </Badge>
    );
  return (
    <div className="flex flex-col gap-3">
      {k.target === null || k.progressBp === null ? (
        <ChartEmpty
          height={96}
          message={t('none')}
          hint={canEditTarget ? t('none-hint-edit') : t('none-hint')}
        />
      ) : (
        <Gauge
          label={t('title')}
          value={k.progressBp / 100}
          max={100}
          display={kpiRate(k.progressBp, locale)}
          caption={t('of-target')}
          formatValue={(n) => `${Math.round(n)}%`}
          emptyLabel={t('none')}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {pace}
        <Badge tone="neutral">{t('estimate')}</Badge>
      </div>
      <p className="m-0 text-sm text-fg-secondary">{forecast}</p>
      <div className="grid grid-cols-2 gap-3">
        <Tile label={t('target')}>
          {k.target === null ? (
            <span className="text-sm font-medium text-fg-secondary">{t('not-set')}</span>
          ) : (
            <span className={FIGURE}>{money(k.target)}</span>
          )}
        </Tile>
        <Tile
          label={t('to-date', { month: kpiMonthName(k.month, locale) })}
          hint={
            k.toGo === null || k.perDayToGo === null
              ? undefined
              : t('to-go', {
                  days: k.daysLeft,
                  amount: money(k.toGo),
                  perDay: money(k.perDayToGo),
                })
          }
        >
          <span className={FIGURE}>{money(k.monthToDate)}</span>
        </Tile>
      </div>
    </div>
  );
}

/**
 * The current calendar month of the Market against its monthly revenue target. With the manage key
 * (and the session's CSRF token) the header has an Edit button that opens the target dialog.
 */
export function MarketTargetCard({
  source,
  allowed,
  editToken,
}: CardProps & {
  /** The CSRF token when the session may change the target; absent: read-only. */
  readonly editToken?: string | undefined;
}) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const frame = { id: 'dash-market-target', title: t('target.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        const target = part(result, allowed.target, (v) => v.marketTarget);
        if (target.kind === 'hidden') return null;
        if (target.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const k = target.kpis;
        return (
          <DashboardCard
            {...frame}
            scope={t('target.scope', { month: kpiMonthName(k.month, locale) })}
            titleAdornment={<Hint name={frame.title} definition={t('def.target')} />}
            {...(editToken === undefined
              ? {}
              : {
                  headerRight: <TargetEditButton currency={k.currency} csrfToken={editToken} />,
                })}
          >
            <TargetBody k={k} canEditTarget={editToken !== undefined} />
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

const STEPS = ['viewed', 'carted', 'checkedOut', 'paid'] as const;
type StepId = (typeof STEPS)[number];

function FunnelRow({
  id,
  step,
  first,
  period,
  ...props
}: {
  readonly id: StepId;
  readonly step: FunnelStepKpi;
  readonly first: number | null;
  readonly period: CardProps['period'];
  readonly previous: StepId | null;
}) {
  const t = useTranslations('dashboard.kpis.funnel');
  const locale = useLocale();
  const delta = useDelta(period);
  const hidden = step.count === null;
  const width =
    step.count === null || first === null || first <= 0
      ? 0
      : Math.max(2, Math.min(100, (step.count / first) * 100));
  const change: StatDeltaProps | undefined = hidden
    ? undefined
    : props.previous === null
      ? delta(step.change, 'percent', 'better')
      : delta(step.rateChange, 'points', 'better');
  const rate =
    props.previous === null || step.rateBp === null
      ? props.previous === null
        ? t('shoppers')
        : null
      : t('rate', { rate: kpiRate(step.rateBp, locale), of: t(`of.${props.previous}`) });
  return (
    <li className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="min-w-0 break-words text-fg">{t(`step.${id}`)}</span>
        <span className="shrink-0 font-semibold tabular-nums text-fg">
          {hidden ? (
            <span className="font-medium text-fg-secondary">{t('hidden')}</span>
          ) : (
            formatCount(step.count ?? 0, false, locale)
          )}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="block h-3 w-full overflow-hidden rounded-sm bg-chart-track"
      >
        {width === 0 ? null : (
          <span
            className={`block h-full rounded-sm ${props.previous === null ? 'bg-chart-series' : 'bg-chart-split'}`}
            style={{ width: `${width}%` }}
          />
        )}
      </span>
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <span className={MUTED}>{rate}</span>
        {change === undefined ? null : <StatDelta {...change} />}
      </span>
    </li>
  );
}

function FunnelBody({
  k,
  period,
}: {
  readonly k: ShoppingFunnelKpis;
  readonly period: CardProps['period'];
}) {
  const t = useTranslations('dashboard.kpis.funnel');
  if (k.status === 'not-enough-data') {
    return (
      <ChartEmpty
        height={160}
        message={t('not-enough')}
        hint={t('not-enough-hint', { minimum: k.minimum ?? 20 })}
      />
    );
  }
  const first = k.viewed?.count ?? null;
  return (
    <ol aria-label={t('list')} className="flex flex-col gap-3">
      {STEPS.map((id, index) => {
        const step = k[id];
        if (step === undefined) return null;
        return (
          <FunnelRow
            key={id}
            id={id}
            step={step}
            first={first}
            period={period}
            previous={index === 0 ? null : (STEPS[index - 1] ?? null)}
          />
        );
      })}
    </ol>
  );
}

/** Viewed, carted, checked out and paid, as customer-days of the period. */
export function ShoppingFunnelCard({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const stalled = useStalled();
  const range = useRange();
  const coverage = useCoverage();
  const frame = { id: 'dash-shopping-funnel', title: t('funnel.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        const funnel = part(result, allowed.orders, (v) => v.shoppingFunnel);
        if (funnel.kind === 'hidden') return null;
        if (funnel.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const k = funnel.kpis;
        return (
          <DashboardCard
            {...frame}
            scope={joined(
              t('funnel.scope'),
              range(funnel.value),
              coverage(k.recordedDays, k.periodDays),
            )}
            titleAdornment={<Hint name={frame.title} definition={t('def.funnel')} />}
          >
            <FunnelBody k={k} period={period} />
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

/** Carts untouched for a day or more on the latest snapshot day of the period: a level, not a sum. */
export function AbandonedCartsCard({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const delta = useDelta(period);
  const label = t('carts.title');
  const base = {
    icon: 'inbox' as const,
    tile: 'slate' as const,
    label,
    definition: t('def.carts'),
    definitionLabel: t('def.what', { name: label }),
  };
  return (
    <Slot source={source} fallback={<Skeleton icon="inbox" label={label} />}>
      {(result) => {
        const carts = part(result, allowed.orders, (v) => v.abandonedCarts);
        if (carts.kind === 'hidden') return null;
        if (carts.kind === 'failed')
          return <KpiCard {...base} scope={t('carts.scope')} error={stalled} />;
        const k = carts.kpis;
        if (k.status === 'not-enough-data' || k.carts === undefined) {
          return (
            <KpiCard
              {...base}
              scope={t('carts.scope')}
              note={
                k.recordedDays === 0
                  ? t('carts.no-snapshot')
                  : t('carts.not-enough', { minimum: k.minimum ?? 5 })
              }
            />
          );
        }
        const value =
          k.approximateValue === null || k.approximateValue === undefined
            ? t('carts.value-mixed')
            : t('carts.value', { amount: kpiMoney(k.approximateValue, locale) });
        const change = delta(k.change, 'percent', 'worse');
        return (
          <KpiCard
            {...base}
            value={formatCount(k.carts, false, locale)}
            scope={joined(
              k.asOfDay === undefined
                ? t('carts.scope')
                : t('carts.as-of', { day: kpiDayLabel(k.asOfDay, locale) }),
              value,
            )}
            {...(change === undefined ? {} : { delta: change })}
          />
        );
      }}
    </Slot>
  );
}

/**
 * The texts shoppers searched that found nothing. Each text is data typed by shoppers: it is
 * rendered only as a plain React text node (never HTML, never a link, never a title attribute
 * built into markup), so markup in it shows as the characters it is.
 */
export function ZeroResultSearchesCard({ source, allowed }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const range = useRange();
  const coverage = useCoverage();
  const frame = { id: 'dash-zero-results', title: t('searches.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        const searches = part(result, allowed.searches, (v) => v.zeroResultSearches);
        if (searches.kind === 'hidden') return null;
        if (searches.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const k = searches.kpis;
        const queries = k.queries ?? [];
        const body =
          k.status === 'not-enough-data' ? (
            <ChartEmpty
              height={160}
              message={t('searches.not-enough')}
              hint={t('searches.not-enough-hint', { minimum: k.minimumSearchers ?? 10 })}
            />
          ) : queries.length === 0 ? (
            <ChartEmpty height={160} message={t('searches.empty')} />
          ) : (
            <ol aria-label={frame.title} className="flex flex-col">
              {queries.map((row, index) => (
                <li
                  // The text is unique in the answer; the index keeps the key safe anyway.
                  key={`${index}-${row.query}`}
                  className="flex items-start justify-between gap-4 border-t border-line-row py-2 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span data-zero-result-query="" className="break-words text-sm text-fg">
                      {row.query}
                    </span>
                    <span className={MUTED}>
                      {t('searches.days', {
                        days: row.days,
                        shoppers: formatCount(row.searcherDays, false, locale),
                      })}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-fg">
                    {formatCount(row.searches, false, locale)}
                  </span>
                </li>
              ))}
            </ol>
          );
        return (
          <DashboardCard
            {...frame}
            scope={joined(
              t('searches.scope'),
              range(searches.value),
              coverage(k.recordedDays, k.periodDays),
            )}
            titleAdornment={<Hint name={frame.title} definition={t('def.searches')} />}
          >
            {body}
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

/** Seller orders paid in the period by the state they were delivered to. */
export function OrdersByStateCard({ source, allowed }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const range = useRange();
  const frame = { id: 'dash-orders-by-state', title: t('by-state.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        const states = part(result, allowed.orders, (v) => v.ordersByState);
        if (states.kind === 'hidden') return null;
        if (states.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const k = states.kpis;
        const scope = joined(t('by-state.scope'), range(states.value));
        const item = (id: string, label: string, orders: number, shareBp: number): BarListItem => ({
          id,
          label,
          value: orders,
          display: t('by-state.row', {
            orders: formatCount(orders, false, locale),
            share: kpiRate(shareBp, locale),
          }),
        });
        const body =
          k.status === 'not-enough-data' ? (
            <ChartEmpty
              height={160}
              message={k.paid === 0 ? t('by-state.empty') : t('by-state.not-enough')}
              {...(k.paid === 0
                ? {}
                : { hint: t('by-state.not-enough-hint', { minimum: k.minimum }) })}
            />
          ) : (
            <BarList
              label={frame.title}
              items={[
                ...k.states.map((row) =>
                  item(`state-${row.state}`, row.state, row.orders, row.shareBp),
                ),
                ...(k.other === null || k.other.orders === 0
                  ? []
                  : [item('other', t('by-state.other'), k.other.orders, k.other.shareBp)]),
                ...(k.unknown === null || k.unknown.orders === 0
                  ? []
                  : [item('unknown', t('by-state.unknown'), k.unknown.orders, k.unknown.shareBp)]),
              ]}
            />
          );
        return (
          <DashboardCard
            {...frame}
            scope={scope}
            titleAdornment={<Hint name={frame.title} definition={t('def.by-state')} />}
          >
            {body}
          </DashboardCard>
        );
      }}
    </Slot>
  );
}

function KindRow({ row }: { readonly row: DiscountKindCost }) {
  const t = useTranslations('dashboard.kpis.discounts');
  const locale = useLocale();
  return (
    <li className="flex items-start justify-between gap-4 border-t border-line-row py-2 first:border-t-0 first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-fg">{t(`kind.${row.kind}`)}</span>
        <span className={MUTED}>
          {row.uses === null ? t('held-back') : t('uses', { count: row.uses })}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-sm font-semibold tabular-nums text-fg">
          {row.amount === null ? '-' : kpiMoney(row.amount, locale)}
        </span>
        {row.shareBp === null ? null : (
          <span className={MUTED}>{kpiRate(row.shareBp, locale)}</span>
        )}
      </span>
    </li>
  );
}

/** What the discounts of the period's paid orders cost, with GST, and who funded them. */
export function DiscountCostCard({ source, allowed, period }: CardProps) {
  const t = useTranslations('dashboard.kpis');
  const locale = useLocale();
  const stalled = useStalled();
  const range = useRange();
  const delta = useDelta(period);
  const frame = { id: 'dash-discount-cost', title: t('discounts.title') };
  return (
    <Slot source={source} fallback={<CardSkeleton {...frame} height={220} />}>
      {(result) => {
        const cost = part(result, allowed.discounts, (v) => v.discountCost);
        if (cost.kind === 'hidden') return null;
        if (cost.kind === 'failed') return <DashboardCard {...frame} error={stalled} />;
        const k = cost.kpis;
        const scope = joined(t('discounts.scope'), range(cost.value));
        const card = (body: ReactNode) => (
          <DashboardCard
            {...frame}
            scope={scope}
            titleAdornment={<Hint name={frame.title} definition={t('def.discounts')} />}
          >
            {body}
          </DashboardCard>
        );
        if (k.status === 'not-enough-data' || k.amount === undefined) {
          return card(
            <ChartEmpty
              height={160}
              message={k.orders === 0 ? t('discounts.empty') : t('discounts.not-enough')}
              {...(k.orders === 0
                ? {}
                : {
                    hint: t('discounts.not-enough-hint', {
                      minimum: k.minimum ?? 5,
                      orders: k.orders,
                    }),
                  })}
            />,
          );
        }
        const raw = delta(guardDelta(k.change, k.amount, k.previousAmount), 'percent', 'worse');
        // More spend is a choice, not a fault: the change is shown without a judgement colour.
        const change = raw === undefined ? undefined : { ...raw, sentiment: 'neutral' as const };
        return card(
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-2xl font-semibold tabular-nums text-fg">
                {kpiMoney(k.amount, locale)}
              </span>
              <span className={MUTED}>{t('discounts.orders', { count: k.orders })}</span>
              {change === undefined ? null : <StatDelta {...change} />}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Tile
                label={t('discounts.platform')}
                hint={
                  k.platformShareBp === null || k.platformShareBp === undefined
                    ? undefined
                    : t('discounts.of-total', { share: kpiRate(k.platformShareBp, locale) })
                }
              >
                <span className={FIGURE}>
                  {k.platformShare === undefined ? '-' : kpiMoney(k.platformShare, locale)}
                </span>
              </Tile>
              <Tile label={t('discounts.sellers')}>
                <span className={FIGURE}>
                  {k.sellerShare === undefined ? '-' : kpiMoney(k.sellerShare, locale)}
                </span>
              </Tile>
            </div>
            {k.byKind === undefined || k.byKind.length === 0 ? null : (
              <ul aria-label={t('discounts.by-kind')} className="flex flex-col">
                {k.byKind.map((row) => (
                  <KindRow key={row.kind} row={row} />
                ))}
              </ul>
            )}
            <p className={`m-0 ${MUTED}`}>
              {k.released === null || k.released === undefined
                ? t('discounts.released-held')
                : t('discounts.released', {
                    count: k.released.orders,
                    amount: kpiMoney(k.released.amount, locale),
                  })}
            </p>
          </div>,
        );
      }}
    </Slot>
  );
}
