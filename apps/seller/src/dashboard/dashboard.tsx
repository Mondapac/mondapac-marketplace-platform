import {
  ActivityCardSkeleton,
  ActivityTable,
  Badge,
  ChartCardSkeleton,
  Banner,
  DashboardCard,
  DashboardGrid,
  DashboardLoading,
  DashboardSlot,
  EmptyState,
  GridItem,
  LinkButton,
  PageHeader,
  activitySkeletonColumns,
  formatCount,
  type ActivityColumn,
  type BadgeTone,
  type DashboardSource,
  type GridLayout,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { known, shortInstant } from '../catalog/format.ts';
import { PAYOUT_ACCOUNT_PATH, type PayoutAccount } from '../payout/types.ts';
import type { SourcesView } from '../stock/types.ts';
import { TodaysTasks } from '../work-queue/todays-tasks.tsx';
import { formatMinor } from '../price/money.ts';
import type { SellerOrderView } from '../orders/types.ts';
import type { SellerKpiSources } from './kpis/load.ts';
import { KpiItems } from './kpis/kpi-section.tsx';
import { PeriodSwitch } from './kpis/period-switch.tsx';
import { DEFAULT_PERIOD, PERIODS, type Period } from './kpis/types.ts';
import { RECENT, type SellerDashboardSources, type Widget } from './types.ts';

const FULFILMENTS = ['to-ship', 'shipped', 'delivered'] as const;
// A routine status is not a warning: no attention (amber) tone for an order to ship.
const FULFILMENT_TONE: Record<string, BadgeTone> = {
  'to-ship': 'info',
  shipped: 'neutral',
  delivered: 'success',
};
const STOCK_STATUSES = ['low', 'out'] as const;
const STOCK_TONE: Record<string, BadgeTone> = { low: 'attention', out: 'critical' };
/** Quick actions: each needs the keys of the page it opens (the same as that page checks). */
const ACTIONS = [
  { id: 'add-product', href: '/products/new', anyOf: ['catalog.own-product.edit'] },
  { id: 'offers', href: '/offers', anyOf: ['catalog.own-product.view'] },
  { id: 'stock-locations', href: '/settings/stock-locations', anyOf: ['inventory.stock.view'] },
  {
    id: 'payout-account',
    href: PAYOUT_ACCOUNT_PATH,
    anyOf: ['payments.payout-account.view'],
  },
  {
    id: 'invite-team',
    href: '/settings/team',
    anyOf: ['identity.team-member.view', 'identity.team-member.invite'],
  },
] as const;

function ok<T>(widget: Widget<T> | null): T | null {
  return widget?.kind === 'ok' ? widget.value : null;
}

function Time({ iso }: { readonly iso: string }) {
  const locale = useLocale();
  const zone = useTimeZone();
  return <span>{shortInstant(iso, locale, zone)}</span>;
}

type Source<T> = DashboardSource<Widget<T> | null>;

/** The text a card skeleton needs: "Still loading…" at 10 s, the card error at 30 s. */
function useSkeletonText() {
  const t = useTranslations();
  return { slowLabel: t('route.slow'), stalledLabel: t('dashboard.error.card') };
}

function NoticeBanners({
  payout,
  sources,
}: {
  readonly payout: Widget<PayoutAccount> | null;
  readonly sources: Widget<SourcesView> | null;
}) {
  const t = useTranslations('dashboard');
  const notices: ReactNode[] = [];
  if (payout?.kind === 'error') {
    notices.push(
      <Banner key="payout-error" tone="info">
        {t('notice.payout-unreadable')}
      </Banner>,
    );
  }
  const account = ok(payout);
  if (account !== null && !account.ready) {
    notices.push(
      <Banner key="payout" tone="attention" title={t('notice.payout.title')}>
        <p>
          {t('notice.payout.body')}{' '}
          <a className="font-medium underline" href={PAYOUT_ACCOUNT_PATH}>
            {t('notice.payout.action')}
          </a>
        </p>
      </Banner>,
    );
  }
  const view = ok(sources);
  if (view !== null && view.sources.length === 0) {
    notices.push(
      <Banner key="sources" tone="attention" title={t('notice.sources.title')}>
        <p>
          {t('notice.sources.body')}{' '}
          <a className="font-medium underline" href="/settings/stock-locations">
            {t('notice.sources.action')}
          </a>
        </p>
      </Banner>,
    );
  }
  if (notices.length === 0) return null;
  return <div className="flex flex-col gap-3">{notices}</div>;
}

/**
 * Things to fix before selling or being paid; shown above the figures once both reads answer
 * (no skeleton: most of the time there is nothing to say).
 */
function Notices({ data }: { readonly data: SellerDashboardSources }) {
  return (
    <DashboardSlot source={data.payout} fallback={null}>
      {(payout) => (
        <DashboardSlot source={data.sources} fallback={null}>
          {(sources) => <NoticeBanners payout={payout} sources={sources} />}
        </DashboardSlot>
      )}
    </DashboardSlot>
  );
}

/** The title, scope line and link of a card, shared by the card and its skeleton. */
interface Frame {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly action?: { readonly href: string; readonly label: string };
}

/** An activity card: its skeleton (real title, link and headers) while its read runs, then the card. */
function ActivitySection<T, Row>({
  source,
  frame,
  columns,
  titleLines,
  layout,
  children,
}: {
  readonly source: Source<T>;
  readonly frame: Frame;
  readonly columns: readonly ActivityColumn<Row>[];
  readonly titleLines?: number;
  readonly layout?: GridLayout;
  readonly children: (widget: Widget<T>) => ReactNode;
}) {
  const text = useSkeletonText();
  return (
    <DashboardSlot
      source={source}
      {...(layout === undefined ? {} : { layout })}
      fallback={
        <ActivityCardSkeleton
          {...frame}
          {...text}
          columns={activitySkeletonColumns(columns)}
          rows={RECENT}
          {...(titleLines === undefined ? {} : { titleLines })}
        />
      }
    >
      {(widget) => (widget === null ? null : children(widget))}
    </DashboardSlot>
  );
}

function useOrderColumns(): ActivityColumn<SellerOrderView>[] {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  return [
    {
      id: 'order',
      header: t('orders.col.order'),
      kind: 'title',
      cell: (row) => (
        <a
          className="font-medium text-link underline"
          href={`/orders/${encodeURIComponent(row.sellerOrderId)}`}
          title={row.sellerOrderId}
        >
          {row.sellerOrderId.slice(-8).toUpperCase()}
        </a>
      ),
    },
    {
      id: 'status',
      header: t('orders.col.status'),
      kind: 'corner',
      size: 'status',
      cell: (row) => {
        const status = known(row.fulfilment, FULFILMENTS);
        return (
          <Badge tone={FULFILMENT_TONE[status] ?? 'neutral'}>{t(`orders.status.${status}`)}</Badge>
        );
      },
    },
    {
      id: 'total',
      header: t('orders.col.total'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => (
        <span className="tabular-nums">
          {formatMinor(row.total.amount, row.total.currency, locale)}
        </span>
      ),
    },
    {
      id: 'paid',
      header: t('orders.col.paid'),
      kind: 'labelled',
      size: 'zoned-date',
      cell: (row) => <Time iso={row.paidAt} />,
    },
  ];
}

function Orders({ data }: { readonly data: SellerDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useOrderColumns();
  if (data.orders === null) return null;
  const frame: Frame = {
    id: 'dash-orders',
    title: t('orders.title'),
    scope: t('scope.latest', { count: RECENT }),
    action: { href: '/orders', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.orders} frame={frame} columns={columns} layout={{ span: 12 }}>
      {(widget) => {
        const page = ok(widget);
        const rows = page?.sellerOrders.slice(0, RECENT) ?? [];
        return (
          <DashboardCard
            {...frame}
            flush={rows.length > 0}
            {...(page === null ? { error: t('error.card') } : {})}
          >
            {rows.length === 0 ? (
              <EmptyState size="compact" icon="clipboard" title={t('orders.empty')} />
            ) : (
              <ActivityTable
                caption={frame.title}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.sellerOrderId}
              />
            )}
          </DashboardCard>
        );
      }}
    </ActivitySection>
  );
}

/** Out of stock first, then low stock; the API's order (latest change first) holds within each. */
const byUrgency = (a: { readonly status: string }, b: { readonly status: string }): number =>
  Number(b.status === 'out') - Number(a.status === 'out');

/**
 * The stock watch: sell units that are low or out of stock, each opening that offer's stock page.
 * Best sellers first needs a per-offer sales read that does not exist yet (FE-20261124-seller-stock-watch-best-sellers-first), so the order
 * is out of stock first, then low stock, each by latest change.
 */
function LowStock({
  data,
  canOpenOffers,
}: {
  readonly data: SellerDashboardSources;
  /** The session may open the offers list (the "View all" link). */
  readonly canOpenOffers: boolean;
}) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const text = useSkeletonText();
  if (data.lowStock === null) return null;
  const frame = {
    id: 'dash-low-stock',
    title: t('low-stock.title'),
    scope: t('low-stock.scope'),
    // No low-stock filter on the offers list yet (FE-20261124-offers-list-low-stock-filter): the link opens the list itself.
    ...(canOpenOffers ? { action: { href: '/offers', label: t('view-all') } } : {}),
  };
  return (
    <DashboardSlot
      layout={{ span: 4, tabletSpan: 6 }}
      source={data.lowStock}
      fallback={<ChartCardSkeleton {...frame} height={160} {...text} />}
    >
      {(widget) => {
        if (widget === null) return null;
        const page = ok(widget);
        const rows = [...(page?.items ?? [])].sort(byUrgency).slice(0, RECENT);
        return (
          <DashboardCard {...frame} {...(page === null ? { error: t('error.card') } : {})}>
            {rows.length === 0 ? (
              <EmptyState size="compact" icon="check" title={t('low-stock.empty')} />
            ) : (
              <ul aria-label={frame.title} className="flex flex-col divide-y divide-line-row">
                {rows.map((row) => {
                  const status = known(row.status, STOCK_STATUSES);
                  return (
                    <li
                      key={`${row.offerId}:${row.variantId}`}
                      className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0"
                    >
                      <a
                        className="min-w-0 break-words font-medium text-link underline"
                        href={`/offers/${encodeURIComponent(row.offerId)}/stock`}
                      >
                        {[row.productName ?? t('unnamed-product'), row.variantLabel]
                          .filter((part) => part !== null && part !== '')
                          .join(' · ')}
                      </a>
                      <Badge tone={STOCK_TONE[status] ?? 'neutral'}>
                        {status === 'low' && row.onlyLeft !== null
                          ? t('low-stock.left', { count: formatCount(row.onlyLeft, false, locale) })
                          : t(`low-stock.status.${status}`)}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </DashboardCard>
        );
      }}
    </DashboardSlot>
  );
}

function QuickActions({ keys }: { readonly keys: ReadonlySet<string> }) {
  const t = useTranslations('dashboard');
  const actions = ACTIONS.filter((action) => action.anyOf.every((key) => keys.has(key)));
  if (actions.length === 0) return null;
  return (
    <GridItem span={12}>
      <DashboardCard id="dash-actions" title={t('actions.title')}>
        <ul className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {actions.map((action, index) => (
            <li key={action.id} className="flex">
              <LinkButton
                variant={index === 0 && action.id === 'add-product' ? 'primary' : 'secondary'}
                href={action.href}
                className="w-full sm:w-auto"
              >
                {t(`actions.${action.id}`)}
              </LinkButton>
            </li>
          ))}
        </ul>
      </DashboardCard>
    </GridItem>
  );
}

/** True once every widget has answered with nothing to show (no key, or the API refused). */
function allRefused(data: SellerDashboardSources): DashboardSource<boolean> {
  const values = Object.values(data) as unknown[];
  if (!values.some((value) => value instanceof Promise)) return values.every((v) => v === null);
  return Promise.all(values).then((answers) => answers.every((answer) => answer === null));
}

/**
 * The seller dashboard (the home page of an approved seller) on the 12-column grid. Order: the
 * four headline cards (on a phone first, then the tasks), the sales chart and the store health,
 * today's tasks, the best-selling categories, the stock watch, the recent orders and the quick
 * actions. Every widget is present only when the session holds the key its read needs. Given
 * promises (the page), each card shows its skeleton until its own read answers (panel loading L4).
 * The period switch drives the figures and the chart; it lives in the address (`?period=`).
 */
export function SellerDashboard({
  title,
  data,
  permissionKeys,
  kpis,
  period = DEFAULT_PERIOD,
}: {
  /** The page title (the h1 of the title row, which holds the period switch). */
  readonly title: string;
  readonly data: SellerDashboardSources;
  readonly permissionKeys: readonly string[];
  /** The KPI reads; absent without the orders key (the figures are sums of the orders). */
  readonly kpis?: SellerKpiSources | null;
  readonly period?: Period;
}) {
  const t = useTranslations('dashboard');
  const tk = useTranslations('dashboard.kpi');
  const keys = new Set(permissionKeys);
  const actions = ACTIONS.some((action) => action.anyOf.every((key) => keys.has(key)));
  const nothing =
    kpis == null && Object.values(data).every((widget) => widget === null) && !actions;
  if (nothing) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={title} />
        <EmptyState size="card" icon="home" title={t('none.title')} body={t('none.body')} />
      </div>
    );
  }
  const grid = (
    <DashboardGrid>
      {kpis == null ? null : <KpiItems sources={kpis} period={period} />}
      <TodaysTasks source={data.tasks} layout={{ span: 4, tabletSpan: 6, mobileOrder: 'tasks' }} />
      <LowStock data={data} canOpenOffers={keys.has('catalog.own-product.view')} />
      <Orders data={data} />
      <QuickActions keys={keys} />
    </DashboardGrid>
  );
  const body = (
    <>
      <Notices data={data} />
      {grid}
    </>
  );
  return (
    <DashboardLoading label={t('loading')} className="flex flex-col gap-4">
      {kpis == null ? <PageHeader title={title} /> : null}
      {actions || kpis != null ? null : (
        // Every read the session may ask for came back refused: say so, as for a role with none.
        <DashboardSlot source={allRefused(data)} fallback={null}>
          {(refused) =>
            refused ? (
              <EmptyState size="card" icon="home" title={t('none.title')} body={t('none.body')} />
            ) : null
          }
        </DashboardSlot>
      )}
      {kpis == null ? (
        body
      ) : (
        <PeriodSwitch
          title={title}
          label={tk('period.label')}
          options={PERIODS.map((id) => ({ id, label: tk(`period.${id}`) }))}
          value={period}
        >
          {body}
        </PeriodSwitch>
      )}
    </DashboardLoading>
  );
}
