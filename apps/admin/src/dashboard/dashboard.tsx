import {
  ActivityTable,
  Badge,
  DashboardCard,
  DistributionBar,
  EmptyState,
  LinkButton,
  StatCard,
  StatGrid,
  formatCount,
  type ActivityColumn,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { ReviewRow } from '../catalog/types.ts';
import { AccountStatusBadge } from '../payments/status-badge.tsx';
import type { ConnectedAccountRow } from '../payments/types.ts';
import { formatMoney, percentChange } from '../pricing/format.ts';
import type { PriceHoldRow } from '../pricing/types.ts';
import { known } from '../sellers/format.ts';
import type { SellerRow } from '../sellers/types.ts';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import {
  ACCOUNTS_PAGE,
  COUNT_LIMIT,
  ORDER_STATUSES,
  RECENT,
  type AdminDashboardData,
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
    href: '/team',
    anyOf: ['identity.admin-account.view', 'identity.admin-account.invite'],
  },
  {
    id: 'create-role',
    href: '/roles/new',
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

/** The Needs attention figures; a figure whose read failed says so in its card. */
function Attention({ data }: { readonly data: AdminDashboardData }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const failed = t('error.card');
  const cards: ReactNode[] = [];
  if (data.sellers !== null) {
    const page = ok(data.sellers);
    const total =
      page === null
        ? 0
        : page.counts.awaitingReview.onboarding + page.counts.awaitingReview.identityChange;
    cards.push(
      <StatCard
        key="sellers"
        icon="store"
        label={t('attention.sellers.label')}
        value={formatCount(total, false, locale)}
        scope={t('attention.sellers.scope')}
        href="/sellers"
        tone={total > 0 ? 'attention' : 'neutral'}
        {...(page === null ? { error: failed } : {})}
      />,
    );
  }
  if (data.holds !== null) {
    const page = ok(data.holds);
    const more = page?.next != null;
    cards.push(
      <StatCard
        key="holds"
        icon="clock"
        label={t('attention.holds.label')}
        value={formatCount(page?.items.length ?? 0, more, locale)}
        scope={t(more ? 'scope.first-page' : 'scope.whole-queue', { count: COUNT_LIMIT })}
        href="/price-holds"
        tone={(page?.items.length ?? 0) > 0 ? 'attention' : 'neutral'}
        {...(page === null ? { error: failed } : {})}
      />,
    );
  }
  if (data.offers !== null) {
    const page = ok(data.offers);
    const more = page?.nextAfterId != null;
    cards.push(
      <StatCard
        key="offers"
        icon="inbox"
        label={t('attention.offers.label')}
        value={formatCount(page?.items.length ?? 0, more, locale)}
        scope={t(more ? 'scope.first-page' : 'scope.whole-queue', { count: COUNT_LIMIT })}
        href="/offer-reviews"
        tone={(page?.items.length ?? 0) > 0 ? 'attention' : 'neutral'}
        {...(page === null ? { error: failed } : {})}
      />,
    );
  }
  if (data.accounts !== null) {
    const page = ok(data.accounts);
    const more = page?.nextCursor != null;
    cards.push(
      <StatCard
        key="accounts"
        icon="wallet"
        label={t('attention.accounts.label')}
        value={formatCount(page?.items.length ?? 0, more, locale)}
        scope={t(more ? 'scope.first-page' : 'scope.all-restricted', { count: ACCOUNTS_PAGE })}
        href="/payout-accounts"
        tone={(page?.items.length ?? 0) > 0 ? 'attention' : 'neutral'}
        {...(page === null ? { error: failed } : {})}
      />,
    );
  }
  if (cards.length === 0) return null;
  return <StatGrid label={t('attention.title')}>{cards}</StatGrid>;
}

function Applications({ data }: { readonly data: AdminDashboardData }) {
  const t = useTranslations('dashboard');
  const ts = useTranslations('sellers.list');
  if (data.sellers === null) return null;
  const page = ok(data.sellers);
  const columns: ActivityColumn<SellerRow>[] = [
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
      size: 'text',
      cell: (row) => ts(`kind.${known(row.kind, KINDS)}`),
    },
    {
      id: 'submitted',
      header: ts('col.submitted'),
      kind: 'labelled',
      size: 'date',
      cell: (row) => <Time iso={row.submittedAt} />,
    },
  ];
  return (
    <DashboardCard
      id="dash-applications"
      title={t('applications.title')}
      scope={t('scope.oldest', { count: RECENT })}
      action={{ href: '/sellers', label: t('view-all') }}
      flush={page !== null && page.items.length > 0}
      {...(page === null ? { error: t('error.card') } : {})}
    >
      {page === null ? null : page.items.length === 0 ? (
        <EmptyState size="compact" icon="check" title={t('applications.empty')} />
      ) : (
        <ActivityTable
          caption={t('applications.title')}
          columns={columns}
          rows={page.items}
          rowKey={(row) => row.sellerId}
        />
      )}
    </DashboardCard>
  );
}

function Holds({ data }: { readonly data: AdminDashboardData }) {
  const t = useTranslations('dashboard');
  const tp = useTranslations('pricing.holds');
  const locale = useLocale();
  if (data.holds === null) return null;
  const page = ok(data.holds);
  const rows = page?.items.slice(0, RECENT) ?? [];
  const columns: ActivityColumn<PriceHoldRow>[] = [
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
  return (
    <DashboardCard
      id="dash-holds"
      title={t('holds.title')}
      scope={t('scope.oldest', { count: RECENT })}
      action={{ href: '/price-holds', label: t('view-all') }}
      flush={rows.length > 0}
      {...(page === null ? { error: t('error.card') } : {})}
    >
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="check" title={t('holds.empty')} />
      ) : (
        <ActivityTable
          caption={t('holds.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.recordId}
        />
      )}
    </DashboardCard>
  );
}

function Offers({ data }: { readonly data: AdminDashboardData }) {
  const t = useTranslations('dashboard');
  if (data.offers === null) return null;
  const page = ok(data.offers);
  const rows = page?.items.slice(0, RECENT) ?? [];
  const columns: ActivityColumn<ReviewRow>[] = [
    {
      id: 'offer',
      header: t('offers.col.offer'),
      kind: 'title',
      cell: (row) => (
        <>
          <a className="font-medium text-link underline" href="/offer-reviews">
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
  return (
    <DashboardCard
      id="dash-offers"
      title={t('offers.title')}
      scope={t('scope.oldest', { count: RECENT })}
      action={{ href: '/offer-reviews', label: t('view-all') }}
      flush={rows.length > 0}
      {...(page === null ? { error: t('error.card') } : {})}
    >
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="check" title={t('offers.empty')} />
      ) : (
        <ActivityTable
          caption={t('offers.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.offerId}
        />
      )}
    </DashboardCard>
  );
}

function Accounts({ data }: { readonly data: AdminDashboardData }) {
  const t = useTranslations('dashboard');
  const tp = useTranslations('payments.accounts');
  if (data.accounts === null) return null;
  const page = ok(data.accounts);
  const rows = page?.items.slice(0, RECENT) ?? [];
  const columns: ActivityColumn<ConnectedAccountRow>[] = [
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
      header: tp('col.last-read-utc'),
      kind: 'labelled',
      size: 'date',
      cell: (row) => <Time iso={row.lastReadAt} />,
    },
  ];
  return (
    <DashboardCard
      id="dash-accounts"
      title={t('accounts.title')}
      scope={t('scope.newest', { count: RECENT })}
      action={{ href: '/payout-accounts', label: t('view-all') }}
      flush={rows.length > 0}
      {...(page === null ? { error: t('error.card') } : {})}
    >
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="check" title={t('accounts.empty')} />
      ) : (
        <ActivityTable
          caption={t('accounts.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.sellerId}
        />
      )}
    </DashboardCard>
  );
}

function Orders({ data }: { readonly data: AdminDashboardData }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  if (data.orders === null) return null;
  const page = ok(data.orders);
  const rows = page?.orders.slice(0, RECENT) ?? [];
  const columns: ActivityColumn<DashboardOrder>[] = [
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
  return (
    <DashboardCard
      id="dash-orders"
      title={t('orders.title')}
      scope={t('scope.latest', { count: RECENT })}
      action={{ href: '/orders', label: t('view-all') }}
      flush={rows.length > 0}
      {...(page === null ? { error: t('error.card') } : {})}
    >
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="receipt" title={t('orders.empty')} />
      ) : (
        <ActivityTable
          caption={t('orders.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.orderId}
        />
      )}
    </DashboardCard>
  );
}

/** Sellers by access state: one stacked bar, shown only to an admin who may see identity's state. */
function SellerStates({ data }: { readonly data: AdminDashboardData }) {
  const t = useTranslations('dashboard');
  const ts = useTranslations('sellers.list.tab');
  const counts = ok(data.sellers)?.stateCounts ?? null;
  if (counts === null) return null;
  return (
    <DashboardCard
      id="dash-states"
      title={t('states.title')}
      scope={t('states.scope')}
      action={{ href: '/sellers', label: t('view-all') }}
    >
      <DistributionBar
        emptyLabel={t('states.empty')}
        parts={[
          { id: 'approved', label: ts('approved'), value: counts.approved, tone: 'success' },
          {
            id: 'changes-needed',
            label: ts('changes-needed'),
            value: counts.changesNeeded,
            tone: 'attention',
          },
          {
            id: 'not-approved',
            label: ts('not-approved'),
            value: counts.notApproved,
            tone: 'neutral',
          },
          { id: 'suspended', label: ts('suspended'), value: counts.suspended, tone: 'critical' },
        ]}
      />
    </DashboardCard>
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
 * key its read needs. Order: what needs attention, the latest activity, then quick actions.
 */
export function AdminDashboard({
  data,
  permissionKeys,
}: {
  readonly data: AdminDashboardData;
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
    <div className="flex flex-col gap-4">
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
    </div>
  );
}
