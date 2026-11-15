import {
  ActivityCardSkeleton,
  ActivityTable,
  Badge,
  DashboardCard,
  DashboardLoading,
  DashboardSlot,
  DistributionBar,
  DistributionCardSkeleton,
  EmptyState,
  LinkButton,
  StatCard,
  StatCardSkeleton,
  StatGrid,
  activitySkeletonColumns,
  formatCount,
  type ActivityColumn,
  type BadgeTone,
  type DashboardSource,
  type IconName,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { offerRowsOf, type ReviewPage, type ReviewRow } from '../catalog/types.ts';
import { AccountStatusBadge } from '../payments/status-badge.tsx';
import type { ConnectedAccountPage, ConnectedAccountRow } from '../payments/types.ts';
import { formatMoney, percentChange } from '../pricing/format.ts';
import type { PriceHoldPage, PriceHoldRow } from '../pricing/types.ts';
import { areaName, known } from '../sellers/format.ts';
import type { SellerListPage, SellerRow } from '../sellers/types.ts';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import {
  ACCOUNTS_PAGE,
  COUNT_LIMIT,
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
  { id: 'find-customer', href: '/customers', anyOf: ['identity.customer-account.view'] },
] as const;

function Time({ iso }: { readonly iso: string | null }) {
  const locale = useLocale();
  return <span className="whitespace-nowrap">{shortInstant(iso, locale)}</span>;
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

/** One Needs attention figure: its skeleton while its read runs, then the figure. */
function Figure<T>({
  source,
  icon,
  label,
  children,
}: {
  readonly source: Source<T>;
  readonly icon: IconName;
  readonly label: string;
  readonly children: (widget: Widget<T>) => ReactNode;
}) {
  const { stalledLabel } = useSkeletonText();
  return (
    <DashboardSlot
      source={source}
      fallback={<StatCardSkeleton icon={icon} label={label} stalledLabel={stalledLabel} />}
    >
      {(widget) => (widget === null ? null : children(widget))}
    </DashboardSlot>
  );
}

type Source<T> = DashboardSource<Widget<T> | null>;

function SellersFigure({ widget }: { readonly widget: Widget<SellerListPage> }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const page = ok(widget);
  const total =
    page === null
      ? 0
      : page.counts.awaitingReview.onboarding + page.counts.awaitingReview.identityChange;
  return (
    <StatCard
      icon="store"
      label={t('attention.sellers.label')}
      value={formatCount(total, false, locale)}
      scope={t('attention.sellers.scope')}
      href="/sellers?tab=awaiting-review"
      tone={total > 0 ? 'attention' : 'neutral'}
      {...(page === null ? { error: t('error.card') } : {})}
    />
  );
}

function HoldsFigure({ widget }: { readonly widget: Widget<PriceHoldPage> }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const page = ok(widget);
  const more = page?.next != null;
  return (
    <StatCard
      icon="clock"
      label={t('attention.holds.label')}
      value={formatCount(page?.items.length ?? 0, more, locale)}
      scope={t(more ? 'scope.first-page' : 'scope.whole-queue', { count: COUNT_LIMIT })}
      href="/price-holds"
      tone={(page?.items.length ?? 0) > 0 ? 'attention' : 'neutral'}
      {...(page === null ? { error: t('error.card') } : {})}
    />
  );
}

function OffersFigure({ widget }: { readonly widget: Widget<ReviewPage> }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const page = ok(widget);
  const more = page?.nextAfterId != null;
  const waiting = page === null ? 0 : offerRowsOf(page.items).length;
  return (
    <StatCard
      icon="inbox"
      label={t('attention.offers.label')}
      value={formatCount(waiting, more, locale)}
      scope={t(more ? 'scope.first-page' : 'scope.whole-queue', { count: COUNT_LIMIT })}
      href="/review?type=offer"
      tone={waiting > 0 ? 'attention' : 'neutral'}
      {...(page === null ? { error: t('error.card') } : {})}
    />
  );
}

function AccountsFigure({ widget }: { readonly widget: Widget<ConnectedAccountPage> }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const page = ok(widget);
  const more = page?.nextCursor != null;
  return (
    <StatCard
      icon="wallet"
      label={t('attention.accounts.label')}
      value={formatCount(page?.items.length ?? 0, more, locale)}
      scope={t(more ? 'scope.first-page' : 'scope.all-restricted', { count: ACCOUNTS_PAGE })}
      href="/payout-accounts"
      tone={(page?.items.length ?? 0) > 0 ? 'attention' : 'neutral'}
      {...(page === null ? { error: t('error.card') } : {})}
    />
  );
}

/** The Needs attention figures; each loads on its own, and one whose read failed says so in its card. */
function Attention({ data }: { readonly data: AdminDashboardSources }) {
  const t = useTranslations('dashboard');
  const cards: ReactNode[] = [];
  if (data.sellers !== null) {
    cards.push(
      <Figure key="sellers" source={data.sellers} icon="store" label={t('attention.sellers.label')}>
        {(widget) => <SellersFigure widget={widget} />}
      </Figure>,
    );
  }
  if (data.holds !== null) {
    cards.push(
      <Figure key="holds" source={data.holds} icon="clock" label={t('attention.holds.label')}>
        {(widget) => <HoldsFigure widget={widget} />}
      </Figure>,
    );
  }
  if (data.offers !== null) {
    cards.push(
      <Figure key="offers" source={data.offers} icon="inbox" label={t('attention.offers.label')}>
        {(widget) => <OffersFigure widget={widget} />}
      </Figure>,
    );
  }
  if (data.accounts !== null) {
    cards.push(
      <Figure
        key="accounts"
        source={data.accounts}
        icon="wallet"
        label={t('attention.accounts.label')}
      >
        {(widget) => <AccountsFigure widget={widget} />}
      </Figure>,
    );
  }
  if (cards.length === 0) return null;
  return <StatGrid label={t('attention.title')}>{cards}</StatGrid>;
}

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

function useApplicationColumns(): ActivityColumn<SellerRow>[] {
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
      cell: (row) => <Time iso={row.submittedAt} />,
    },
  ];
}

function Applications({ data }: { readonly data: AdminDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useApplicationColumns();
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

function useHoldColumns(): ActivityColumn<PriceHoldRow>[] {
  const t = useTranslations('dashboard');
  const tp = useTranslations('pricing.holds');
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
      cell: (row) => <Time iso={row.submittedAt} />,
    },
  ];
}

function Holds({ data }: { readonly data: AdminDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useHoldColumns();
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

function useOfferColumns(): ActivityColumn<ReviewRow>[] {
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
      cell: (row) => <Time iso={row.submittedAt} />,
    },
  ];
}

function Offers({ data }: { readonly data: AdminDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useOfferColumns();
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

function useAccountColumns(): ActivityColumn<ConnectedAccountRow>[] {
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
      cell: (row) => <Time iso={row.lastReadAt} />,
    },
  ];
}

function Accounts({ data }: { readonly data: AdminDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useAccountColumns();
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

function useOrderColumns(): ActivityColumn<DashboardOrder>[] {
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
      cell: (row) => <Time iso={row.createdAt} />,
    },
  ];
}

function Orders({ data }: { readonly data: AdminDashboardSources }) {
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

/**
 * The admin dashboard (the home page): every widget is present only when the session holds the
 * key its read needs. Order: what needs attention, the latest activity, then quick actions. Given
 * promises (the page), each card shows its skeleton until its own read answers (panel loading L4).
 */
export function AdminDashboard({
  data,
  permissionKeys,
}: {
  readonly data: AdminDashboardSources;
  readonly permissionKeys: readonly string[];
}) {
  const t = useTranslations('dashboard');
  const keys = new Set(permissionKeys);
  const nothing =
    Object.values(data).every((widget) => widget === null) &&
    !ACTIONS.some((action) => action.anyOf.every((key) => keys.has(key)));
  if (nothing) {
    return <EmptyState size="card" icon="home" title={t('none.title')} body={t('none.body')} />;
  }
  return (
    <DashboardLoading label={t('loading')} className="flex flex-col gap-4">
      <Attention data={data} />
      <Applications data={data} />
      <Holds data={data} />
      <Offers data={data} />
      <Accounts data={data} />
      <Orders data={data} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SellerStates data={data} />
        <QuickActions keys={keys} />
      </div>
    </DashboardLoading>
  );
}
