import {
  ActivityCardSkeleton,
  ActivityTable,
  Badge,
  DashboardCard,
  DashboardLoading,
  DashboardSlot,
  DashboardGrid,
  DistributionBar,
  DistributionCardSkeleton,
  EmptyState,
  GridItem,
  LinkButton,
  PageHeader,
  activitySkeletonColumns,
  type ActivityColumn,
  type BadgeTone,
  type DashboardSource,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { offerRowsOf, type ReviewRow } from '../catalog/types.ts';
import { AccountStatusBadge } from '../payments/status-badge.tsx';
import type { ConnectedAccountRow } from '../payments/types.ts';
import { formatMoney, percentChange } from '../pricing/format.ts';
import type { PriceHoldRow } from '../pricing/types.ts';
import { areaName, known } from '../sellers/format.ts';
import type { SellerRow } from '../sellers/types.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { NeedsAction } from '../work-queue/needs-action.tsx';
import { PERIOD_KEY } from './kpi-format.ts';
import { DEFAULT_KPI_PERIOD, KPI_PERIODS, type AdminKpiSource } from './kpi-types.ts';
import { mayExport, validateRange, type KpiSelection } from './kpi-range.ts';
import { KpiItems } from './kpis.tsx';
import { PeriodSwitch } from './period-switch.tsx';
import {
  ORDER_STATUSES,
  RECENT,
  type AdminDashboardSources,
  type DashboardOrder,
  type Widget,
} from './types.ts';

const ORDER_TONE: Record<string, BadgeTone> = {
  'pending-payment': 'attention',
  confirmed: 'success',
  cancelled: 'neutral',
};

const KINDS = ['onboarding', 'identity-change'] as const;

/** Quick actions: each needs the keys of the page it opens (the same as that page checks). */
const ACTIONS = [
  {
    id: 'invite-admin',
    href: '/settings/admins',
    anyOf: ['identity.admin-account.view', 'identity.admin-account.invite'],
  },
  {
    id: 'create-role',
    href: '/settings/roles/new',
    anyOf: ['identity.platform-role.view', 'identity.platform-role.create'],
  },
  { id: 'without-owner', href: '/sellers/without-owner', anyOf: ['identity.seller-access.view'] },
  { id: 'find-customer', href: '/customers', anyOf: ['customers.customers.view'] },
] as const;

function Time({ iso, zone }: { readonly iso: string | null; readonly zone: string }) {
  const locale = useLocale();
  return <span className="whitespace-nowrap">{shortInstantInZone(iso, locale, zone, true)}</span>;
}

function Name({
  name,
  fallback,
  href,
}: {
  readonly name: string | null;
  readonly fallback: string;
  readonly href: string;
}) {
  return (
    <a className="font-medium text-link underline" href={href}>
      {name ?? fallback}
    </a>
  );
}

function ok<T>(widget: Widget<T> | null): T | null {
  return widget?.kind === 'ok' ? widget.value : null;
}

/** The text a card skeleton needs: "Still loading…" at 10 s, the card error at 30 s. */
function useSkeletonText() {
  const t = useTranslations();
  return { slowLabel: t('route.slow'), stalledLabel: t('dashboard.error.card') };
}

type Source<T> = DashboardSource<Widget<T> | null>;

/** The title, scope line and link of a card, shared by the card and its skeleton. */
interface Frame {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly action: { readonly href: string; readonly label: string };
}

/** An activity card: its skeleton (real title, link and headers) while its read runs, then the card. */
function ActivitySection<T, Row>({
  source,
  frame,
  columns,
  titleLines,
  children,
}: {
  readonly source: Source<T>;
  readonly frame: Frame;
  readonly columns: readonly ActivityColumn<Row>[];
  readonly titleLines?: number;
  readonly children: (widget: Widget<T>) => ReactNode;
}) {
  const text = useSkeletonText();
  return (
    <DashboardSlot
      source={source}
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

function useApplicationColumns(zone: string): ActivityColumn<SellerRow>[] {
  const ts = useTranslations('sellers.list');
  return [
    {
      id: 'store',
      header: ts('col.store'),
      kind: 'title',
      cell: (row) => (
        <Name
          name={row.storeName}
          fallback={ts('unnamed')}
          href={`/sellers/${encodeURIComponent(row.sellerId)}`}
        />
      ),
    },
    {
      id: 'kind',
      header: ts('col.kind'),
      kind: 'labelled',
      size: 'status',
      cell: (row) => ts(`kind.${known(row.kind, KINDS)}`),
    },
    {
      id: 'area',
      header: ts('col.area'),
      kind: 'labelled',
      size: 'figure',
      cell: (row) => areaName(row.serviceAreaCode, row.serviceAreaName) ?? ts('not-given'),
    },
    {
      id: 'submitted',
      header: ts('col.submitted'),
      kind: 'labelled',
      size: 'date',
      cell: (row) => <Time iso={row.submittedAt} zone={zone} />,
    },
  ];
}

function Applications({
  data,
  zone,
}: {
  readonly data: AdminDashboardSources;
  readonly zone: string;
}) {
  const t = useTranslations('dashboard');
  const columns = useApplicationColumns(zone);
  if (data.sellers === null) return null;
  const frame: Frame = {
    id: 'dash-applications',
    title: t('applications.title'),
    scope: t('scope.oldest', { count: RECENT }),
    action: { href: '/sellers?tab=awaiting-review', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.sellers} frame={frame} columns={columns}>
      {(widget) => {
        const page = ok(widget);
        return (
          <DashboardCard
            {...frame}
            flush={page !== null && page.items.length > 0}
            {...(page === null ? { error: t('error.card') } : {})}
          >
            {page === null ? null : page.items.length === 0 ? (
              <EmptyState size="compact" icon="check" title={t('applications.empty')} />
            ) : (
              <ActivityTable
                caption={frame.title}
                columns={columns}
                rows={page.items}
                rowKey={(row) => row.sellerId}
              />
            )}
          </DashboardCard>
        );
      }}
    </ActivitySection>
  );
}

function useHoldColumns(zone: string): ActivityColumn<PriceHoldRow>[] {
  const t = useTranslations('dashboard');
  const tp = useTranslations('pricing.holds.list');
  const locale = useLocale();
  return [
    {
      id: 'product',
      header: tp('col.product'),
      kind: 'title',
      cell: (row) => (
        <>
          <a className="font-medium text-link underline" href="/price-holds">
            {row.productName ?? t('unnamed-product')}
          </a>
          {row.variantLabel === null ? null : (
            <div className="text-fg-muted">{row.variantLabel}</div>
          )}
          {row.storeName === null ? null : <div className="text-fg-muted">{row.storeName}</div>}
        </>
      ),
    },
    {
      id: 'price',
      header: tp('col.price'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => {
        const change = percentChange(row.amount.amount, row.anchorAmount.amount, locale);
        return (
          <span className="tabular-nums">
            {formatMoney(row.amount, locale)}
            {change === null ? null : (
              <span className="block text-xs text-fg-muted">
                {tp(`direction.${row.direction}`)} {change}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: 'submitted',
      header: tp('col.submitted'),
      kind: 'labelled',
      size: 'date',
      cell: (row) => <Time iso={row.submittedAt} zone={zone} />,
    },
  ];
}

function Holds({ data, zone }: { readonly data: AdminDashboardSources; readonly zone: string }) {
  const t = useTranslations('dashboard');
  const columns = useHoldColumns(zone);
  if (data.holds === null) return null;
  const frame: Frame = {
    id: 'dash-holds',
    title: t('holds.title'),
    scope: t('scope.oldest', { count: RECENT }),
    action: { href: '/price-holds', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.holds} frame={frame} columns={columns} titleLines={3}>
      {(widget) => {
        const page = ok(widget);
        const rows = page?.items.slice(0, RECENT) ?? [];
        return (
          <DashboardCard
            {...frame}
            flush={rows.length > 0}
            {...(page === null ? { error: t('error.card') } : {})}
          >
            {rows.length === 0 ? (
              <EmptyState size="compact" icon="check" title={t('holds.empty')} />
            ) : (
              <ActivityTable
                caption={frame.title}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.recordId}
              />
            )}
          </DashboardCard>
        );
      }}
    </ActivitySection>
  );
}

function useOfferColumns(zone: string): ActivityColumn<ReviewRow>[] {
  const t = useTranslations('dashboard');
  return [
    {
      id: 'offer',
      header: t('offers.col.offer'),
      kind: 'title',
      cell: (row) => (
        <>
          <a className="font-medium text-link underline" href="/review?type=offer">
            {row.product.name ?? t('unnamed-product')}
          </a>
          <div className="text-fg-muted">{row.sellerSku}</div>
        </>
      ),
    },
    {
      id: 'seller',
      header: t('offers.col.seller'),
      kind: 'labelled',
      size: 'text',
      cell: (row) => <span title={row.sellerId}>{shortId(row.sellerId)}</span>,
    },
    {
      id: 'submitted',
      header: t('offers.col.submitted'),
      kind: 'labelled',
      size: 'date',
      cell: (row) => <Time iso={row.submittedAt} zone={zone} />,
    },
  ];
}

function Offers({ data, zone }: { readonly data: AdminDashboardSources; readonly zone: string }) {
  const t = useTranslations('dashboard');
  const columns = useOfferColumns(zone);
  if (data.offers === null) return null;
  const frame: Frame = {
    id: 'dash-offers',
    title: t('offers.title'),
    scope: t('scope.oldest', { count: RECENT }),
    action: { href: '/review?type=offer', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.offers} frame={frame} columns={columns} titleLines={2}>
      {(widget) => {
        const page = ok(widget);
        const rows = page === null ? [] : offerRowsOf(page.items).slice(0, RECENT);
        return (
          <DashboardCard
            {...frame}
            flush={rows.length > 0}
            {...(page === null ? { error: t('error.card') } : {})}
          >
            {rows.length === 0 ? (
              <EmptyState size="compact" icon="check" title={t('offers.empty')} />
            ) : (
              <ActivityTable
                caption={frame.title}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.offerId}
              />
            )}
          </DashboardCard>
        );
      }}
    </ActivitySection>
  );
}

function useAccountColumns(zone: string): ActivityColumn<ConnectedAccountRow>[] {
  const t = useTranslations('dashboard');
  const tp = useTranslations('payments.accounts');
  return [
    {
      id: 'seller',
      header: tp('col.seller'),
      kind: 'title',
      cell: (row) => (
        <>
          <Name
            name={row.sellerName}
            fallback={tp('unnamed')}
            href={`/payout-accounts/${encodeURIComponent(row.sellerId)}`}
          />
          <div className="text-fg-muted" title={row.sellerId}>
            {shortId(row.sellerId)}
          </div>
        </>
      ),
    },
    {
      id: 'status',
      header: tp('col.status'),
      kind: 'corner',
      size: 'status',
      cell: (row) => <AccountStatusBadge status={row.status} />,
    },
    {
      id: 'requirements',
      header: tp('col.requirements'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => (
        <span className="tabular-nums">
          {row.requirementsDue}
          {row.requirementsPastDue ? (
            <span className="block text-critical-fg">{tp('past-due')}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'checked',
      header: t('accounts.col.checked'),
      kind: 'labelled',
      size: 'date',
      cell: (row) => <Time iso={row.lastReadAt} zone={zone} />,
    },
  ];
}

function Accounts({ data, zone }: { readonly data: AdminDashboardSources; readonly zone: string }) {
  const t = useTranslations('dashboard');
  const columns = useAccountColumns(zone);
  if (data.accounts === null) return null;
  const frame: Frame = {
    id: 'dash-accounts',
    title: t('accounts.title'),
    scope: t('scope.newest', { count: RECENT }),
    action: { href: '/payout-accounts', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.accounts} frame={frame} columns={columns} titleLines={2}>
      {(widget) => {
        const page = ok(widget);
        const rows = page?.items.slice(0, RECENT) ?? [];
        return (
          <DashboardCard
            {...frame}
            flush={rows.length > 0}
            {...(page === null ? { error: t('error.card') } : {})}
          >
            {rows.length === 0 ? (
              <EmptyState size="compact" icon="check" title={t('accounts.empty')} />
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
    </ActivitySection>
  );
}

function useOrderColumns(zone: string): ActivityColumn<DashboardOrder>[] {
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
          href={`/orders/${encodeURIComponent(row.orderId)}`}
          title={row.orderId}
        >
          {shortId(row.orderId)}
        </a>
      ),
    },
    {
      id: 'status',
      header: t('orders.col.status'),
      kind: 'corner',
      size: 'status',
      cell: (row) => {
        const status = known(row.status, ORDER_STATUSES);
        return <Badge tone={ORDER_TONE[status] ?? 'neutral'}>{t(`orders.status.${status}`)}</Badge>;
      },
    },
    {
      id: 'total',
      header: t('orders.col.total'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => <span className="tabular-nums">{formatMoney(row.total, locale)}</span>,
    },
    {
      id: 'placed',
      header: t('orders.col.placed'),
      kind: 'labelled',
      size: 'date',
      cell: (row) => <Time iso={row.createdAt} zone={zone} />,
    },
  ];
}

function Orders({ data, zone }: { readonly data: AdminDashboardSources; readonly zone: string }) {
  const t = useTranslations('dashboard');
  const columns = useOrderColumns(zone);
  if (data.orders === null) return null;
  const frame: Frame = {
    id: 'dash-orders',
    title: t('orders.title'),
    scope: t('scope.latest', { count: RECENT }),
    action: { href: '/orders', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.orders} frame={frame} columns={columns}>
      {(widget) => {
        const page = ok(widget);
        const rows = page?.orders.slice(0, RECENT) ?? [];
        return (
          <DashboardCard
            {...frame}
            flush={rows.length > 0}
            {...(page === null ? { error: t('error.card') } : {})}
          >
            {rows.length === 0 ? (
              <EmptyState size="compact" icon="receipt" title={t('orders.empty')} />
            ) : (
              <ActivityTable
                caption={frame.title}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.orderId}
              />
            )}
          </DashboardCard>
        );
      }}
    </ActivitySection>
  );
}

/** Sellers by access state: one stacked bar, shown only to an admin who may see identity's state. */
function SellerStates({ data }: { readonly data: AdminDashboardSources }) {
  const t = useTranslations('dashboard');
  const ts = useTranslations('sellers.list.tab');
  const text = useSkeletonText();
  if (data.sellers === null) return null;
  const frame: Frame = {
    id: 'dash-states',
    title: t('states.title'),
    scope: t('states.scope'),
    action: { href: '/sellers', label: t('view-all') },
  };
  const parts = [
    { id: 'approved', label: ts('approved'), tone: 'success' },
    { id: 'changes-needed', label: ts('changes-needed'), tone: 'attention' },
    { id: 'not-approved', label: ts('not-approved'), tone: 'neutral' },
    { id: 'suspended', label: ts('suspended'), tone: 'critical' },
  ] as const;
  return (
    <DashboardSlot
      source={data.sellers}
      fallback={<DistributionCardSkeleton {...frame} {...text} parts={parts} />}
    >
      {(widget) => {
        const counts = ok(widget)?.stateCounts ?? null;
        if (counts === null) return null;
        const value = {
          approved: counts.approved,
          'changes-needed': counts.changesNeeded,
          'not-approved': counts.notApproved,
          suspended: counts.suspended,
        };
        return (
          <DashboardCard {...frame}>
            <DistributionBar
              emptyLabel={t('states.empty')}
              parts={parts.map((part) => ({ ...part, value: value[part.id] }))}
            />
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
    <DashboardCard id="dash-actions" title={t('actions.title')}>
      <ul className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {actions.map((action) => (
          <li key={action.id} className="flex">
            <LinkButton variant="secondary" href={action.href} className="w-full sm:w-auto">
              {t(`actions.${action.id}`)}
            </LinkButton>
          </li>
        ))}
      </ul>
    </DashboardCard>
  );
}

/** True once every widget has answered with nothing to show (no key, or the API refused). */
function allRefused(data: AdminDashboardSources): DashboardSource<boolean> {
  const values = Object.values(data) as unknown[];
  if (!values.some((value) => value instanceof Promise)) return values.every((v) => v === null);
  return Promise.all(values).then((answers) => answers.every((answer) => answer === null));
}

const KPI_QUEUE_LAYOUT = { span: 4, tabletSpan: 12 } as const;

/**
 * The admin dashboard (the home page) on the 12-column grid. Order: the four headline cards, the
 * revenue chart beside "Needs action", sales by category, orders by status, supply and health, the
 * top sellers, then the latest activity and the quick actions. Every widget is present only when
 * the session holds the key its read needs; a refused section is left out, a failed one says so in
 * place. Given promises (the page), each card shows its skeleton until its own read answers (panel
 * loading L4). The period switch sits in the title row and lives in the address (`?period=`).
 */
export function AdminDashboard({
  title,
  data,
  permissionKeys,
  zone,
  kpis = null,
  selection = { id: DEFAULT_KPI_PERIOD },
  today = '',
}: {
  /** The page title (the h1 of the title row, which holds the period switch). */
  readonly title: string;
  readonly data: AdminDashboardSources;
  readonly permissionKeys: readonly string[];
  /** The IANA zone of the activity times (ADR-0005). */
  readonly zone: string;
  /** The KPI read; null when the session holds no key of any KPI section. */
  readonly kpis?: AdminKpiSource | null;
  /** What the address asks for: a preset or a custom range. */
  readonly selection?: KpiSelection;
  /** The Market's day now (`YYYY-MM-DD`): the last day a custom range may end on. */
  readonly today?: string;
}) {
  const t = useTranslations('dashboard');
  const tk = useTranslations('dashboard.kpis');
  const keys = new Set(permissionKeys);
  const actionable = ACTIONS.some((action) => action.anyOf.every((key) => keys.has(key)));
  const nothing =
    kpis === null && Object.values(data).every((widget) => widget === null) && !actionable;
  if (nothing) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={title} />
        <EmptyState size="card" icon="home" title={t('none.title')} body={t('none.body')} />
      </div>
    );
  }
  const queue = (
    <NeedsAction source={data.workQueue} layout={kpis === null ? { span: 12 } : KPI_QUEUE_LAYOUT} />
  );
  const grid = (
    <DashboardGrid>
      {kpis === null ? (
        queue
      ) : (
        <KpiItems
          source={kpis}
          period={selection.id}
          permissionKeys={permissionKeys}
          before={queue}
        />
      )}
      <GridItem span={12}>
        <Applications data={data} zone={zone} />
      </GridItem>
      <GridItem span={12}>
        <Holds data={data} zone={zone} />
      </GridItem>
      <GridItem span={12}>
        <Offers data={data} zone={zone} />
      </GridItem>
      <GridItem span={12}>
        <Accounts data={data} zone={zone} />
      </GridItem>
      <GridItem span={12}>
        <Orders data={data} zone={zone} />
      </GridItem>
      <GridItem span={6} tabletSpan={12}>
        <SellerStates data={data} />
      </GridItem>
      <GridItem span={6} tabletSpan={12}>
        <QuickActions keys={keys} />
      </GridItem>
    </DashboardGrid>
  );
  return (
    <DashboardLoading label={t('loading')} className="flex flex-col gap-4">
      {kpis === null ? <PageHeader title={title} /> : null}
      {actionable || kpis !== null ? null : (
        // Every read the session may ask for came back refused: say so, as for a role with none.
        <DashboardSlot source={allRefused(data)} fallback={null}>
          {(refused) =>
            refused ? (
              <EmptyState size="card" icon="home" title={t('none.title')} body={t('none.body')} />
            ) : null
          }
        </DashboardSlot>
      )}
      {kpis === null ? (
        grid
      ) : (
        <PeriodSwitch
          title={title}
          label={tk('period.label')}
          options={[...KPI_PERIODS, 'custom' as const].map((id) => ({
            id,
            label: tk(`period.${PERIOD_KEY[id]}`),
          }))}
          selection={selection}
          today={today}
          zone={zone}
          fields={
            selection.id === 'custom'
              ? validateRange({ from: selection.from, to: selection.to, today })
              : []
          }
          canExport={mayExport(permissionKeys)}
        >
          {grid}
        </PeriodSwitch>
      )}
    </DashboardLoading>
  );
}
