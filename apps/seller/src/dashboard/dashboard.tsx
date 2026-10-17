import {
  ActivityTable,
  Badge,
  Banner,
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
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { known, OFFER_STATUSES, shortInstant } from '../catalog/format.ts';
import type { OfferView } from '../catalog/types.ts';
import type { LedgerEntry } from '../earnings/types.ts';
import type { SellerOrderView } from '../orders/types.ts';
import { formatMinor } from '../price/money.ts';
import {
  COUNT_LIMIT,
  RECENT,
  type LowStockItem,
  type SellerDashboardData,
  type Widget,
} from './types.ts';

const FULFILMENTS = ['to-ship', 'shipped', 'delivered'] as const;
const LEDGER_KINDS = ['sale', 'shipping', 'commission'] as const;
const FULFILMENT_TONE: Record<string, BadgeTone> = {
  'to-ship': 'attention',
  shipped: 'info',
  delivered: 'success',
};
const STOCK_STATUSES = ['low', 'out'] as const;
const STOCK_TONE: Record<string, BadgeTone> = { low: 'attention', out: 'critical' };
const OFFER_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  'pending-first-publish': 'info',
  'changes-needed': 'attention',
  published: 'success',
};
/** Offers that wait on someone: the platform's review, or the seller's changes. */
const OPEN_OFFERS = ['changes-needed', 'pending-first-publish'] as const;

/** Quick actions: each needs the keys of the page it opens (the same as that page checks). */
const ACTIONS = [
  { id: 'add-product', href: '/products/new', anyOf: ['catalog.own-product.edit'] },
  { id: 'stock-locations', href: '/stock-locations', anyOf: ['inventory.stock.view'] },
  { id: 'payout-account', href: '/payout-account', anyOf: ['payments.payout-account.view'] },
  {
    id: 'invite-team',
    href: '/team',
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

/** Things to fix before selling or being paid; shown above the figures. */
function Notices({ data }: { readonly data: SellerDashboardData }) {
  const t = useTranslations('dashboard');
  const notices: ReactNode[] = [];
  if (data.payout?.kind === 'error') {
    notices.push(
      <Banner key="payout-error" tone="info">
        {t('notice.payout-unreadable')}
      </Banner>,
    );
  }
  const payout = ok(data.payout);
  if (payout !== null && !payout.ready) {
    notices.push(
      <Banner key="payout" tone="attention" title={t('notice.payout.title')}>
        <p>
          {t('notice.payout.body')}{' '}
          <a className="font-medium underline" href="/payout-account">
            {t('notice.payout.action')}
          </a>
        </p>
      </Banner>,
    );
  }
  const sources = ok(data.sources);
  if (sources !== null && sources.sources.length === 0) {
    notices.push(
      <Banner key="sources" tone="attention" title={t('notice.sources.title')}>
        <p>
          {t('notice.sources.body')}{' '}
          <a className="font-medium underline" href="/stock-locations">
            {t('notice.sources.action')}
          </a>
        </p>
      </Banner>,
    );
  }
  if (notices.length === 0) return null;
  return <div className="flex flex-col gap-3">{notices}</div>;
}

/** The Needs attention figures; a figure whose read failed says so in its card. */
function Attention({ data }: { readonly data: SellerDashboardData }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const failed = t('error.card');
  const cards: ReactNode[] = [];
  if (data.orders !== null) {
    const page = ok(data.orders);
    const more = page?.nextCursor != null;
    const count = page?.sellerOrders.filter((order) => order.fulfilment === 'to-ship').length ?? 0;
    cards.push(
      <StatCard
        key="to-ship"
        icon="clipboard"
        label={t('attention.to-ship.label')}
        value={formatCount(count, more, locale)}
        scope={t(more ? 'scope.orders-latest' : 'scope.orders-all', { count: COUNT_LIMIT })}
        href="/orders"
        tone={count > 0 ? 'attention' : 'neutral'}
        {...(page === null ? { error: failed } : {})}
      />,
    );
  }
  if (data.offers !== null) {
    const page = ok(data.offers);
    const more = page?.nextAfterId != null;
    const scope = t(more ? 'scope.offers-latest' : 'scope.offers-all', { count: COUNT_LIMIT });
    const count = (status: string) =>
      page?.items.filter((offer) => offer.status === status).length ?? 0;
    cards.push(
      <StatCard
        key="in-review"
        icon="inbox"
        label={t('attention.in-review.label')}
        value={formatCount(count('pending-first-publish'), more, locale)}
        scope={scope}
        href="/offers"
        {...(page === null ? { error: failed } : {})}
      />,
      <StatCard
        key="changes"
        icon="tag"
        label={t('attention.changes.label')}
        value={formatCount(count('changes-needed'), more, locale)}
        scope={scope}
        href="/offers"
        tone={count('changes-needed') > 0 ? 'attention' : 'neutral'}
        {...(page === null ? { error: failed } : {})}
      />,
    );
  }
  if (data.ledger !== null) {
    const ledger = ok(data.ledger);
    cards.push(
      <StatCard
        key="balance"
        icon="wallet"
        label={t('attention.balance.label')}
        value={ledger === null ? '-' : formatMinor(ledger.totals.balance, ledger.currency, locale)}
        scope={t('attention.balance.scope')}
        href="/earnings"
        {...(ledger === null ? { error: failed } : {})}
      />,
    );
  }
  if (cards.length === 0) return null;
  return <StatGrid label={t('attention.title')}>{cards}</StatGrid>;
}

function Orders({ data }: { readonly data: SellerDashboardData }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  if (data.orders === null) return null;
  const page = ok(data.orders);
  const rows = page?.sellerOrders.slice(0, RECENT) ?? [];
  const columns: ActivityColumn<SellerOrderView>[] = [
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
        <EmptyState size="compact" icon="clipboard" title={t('orders.empty')} />
      ) : (
        <ActivityTable
          caption={t('orders.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.sellerOrderId}
        />
      )}
    </DashboardCard>
  );
}

function Offers({ data }: { readonly data: SellerDashboardData }) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('catalog.offers');
  if (data.offers === null) return null;
  const page = ok(data.offers);
  const rows =
    page?.items
      .filter((offer) => (OPEN_OFFERS as readonly string[]).includes(offer.status))
      .slice(0, RECENT) ?? [];
  const columns: ActivityColumn<OfferView>[] = [
    {
      id: 'offer',
      header: tc('col.product'),
      kind: 'title',
      cell: (row) => (
        <>
          <a
            className="font-medium text-link underline"
            href={`/offers/${encodeURIComponent(row.offerId)}`}
          >
            {row.product.name ?? t('unnamed-product')}
          </a>
          <div className="text-fg-muted">{row.sellerSku}</div>
        </>
      ),
    },
    {
      id: 'status',
      header: t('offers.col.status'),
      kind: 'corner',
      size: 'status',
      cell: (row) => {
        const status = known(row.status, OFFER_STATUSES);
        return <Badge tone={OFFER_TONE[status] ?? 'neutral'}>{tc(`status.${status}`)}</Badge>;
      },
    },
    {
      id: 'submitted',
      header: tc('col.submitted'),
      kind: 'labelled',
      size: 'zoned-date',
      cell: (row) => (row.submittedAt === null ? '-' : <Time iso={row.submittedAt} />),
    },
  ];
  return (
    <DashboardCard
      id="dash-offers"
      title={t('offers.title')}
      scope={t('scope.offers-open', { count: COUNT_LIMIT })}
      action={{ href: '/offers', label: t('view-all') }}
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

/** Sell units that are low or out of stock, latest change first; each opens that offer's stock page. */
function LowStock({ data }: { readonly data: SellerDashboardData }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  if (data.lowStock === null) return null;
  const page = ok(data.lowStock);
  const rows = page?.items.slice(0, RECENT) ?? [];
  const columns: ActivityColumn<LowStockItem>[] = [
    {
      id: 'item',
      header: t('low-stock.col.item'),
      kind: 'title',
      cell: (row) => (
        <a
          className="font-medium text-link underline"
          href={`/offers/${encodeURIComponent(row.offerId)}/stock`}
        >
          {[row.productName ?? t('unnamed-product'), row.variantLabel]
            .filter((part) => part !== null && part !== '')
            .join(' · ')}
        </a>
      ),
    },
    {
      id: 'status',
      header: t('low-stock.col.status'),
      kind: 'corner',
      size: 'status',
      cell: (row) => {
        const status = known(row.status, STOCK_STATUSES);
        return (
          <Badge tone={STOCK_TONE[status] ?? 'neutral'}>{t(`low-stock.status.${status}`)}</Badge>
        );
      },
    },
    {
      id: 'left',
      header: t('low-stock.col.left'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => (
        <span className="tabular-nums">
          {row.onlyLeft === null ? (
            <>
              <span aria-hidden="true">-</span>
              <span className="sr-only">{t('low-stock.none-left')}</span>
            </>
          ) : (
            formatCount(row.onlyLeft, false, locale)
          )}
        </span>
      ),
    },
    {
      id: 'changed',
      header: t('low-stock.col.changed'),
      kind: 'labelled',
      size: 'zoned-date',
      cell: (row) => <Time iso={row.changedAt} />,
    },
  ];
  return (
    <DashboardCard
      id="dash-low-stock"
      title={t('low-stock.title')}
      scope={t('scope.changed-latest')}
      flush={rows.length > 0}
      {...(page === null ? { error: t('error.card') } : {})}
    >
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="check" title={t('low-stock.empty')} />
      ) : (
        <ActivityTable
          caption={t('low-stock.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.offerId}:${row.variantId}`}
        />
      )}
    </DashboardCard>
  );
}

function Earnings({ data }: { readonly data: SellerDashboardData }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  if (data.ledger === null) return null;
  const ledger = ok(data.ledger);
  const rows = ledger?.entries.slice(0, RECENT) ?? [];
  const columns: ActivityColumn<LedgerEntry>[] = [
    {
      id: 'kind',
      header: t('earnings.col.entry'),
      kind: 'title',
      cell: (row) => t(`earnings.kind.${known(row.kind, LEDGER_KINDS)}`),
    },
    {
      id: 'amount',
      header: t('earnings.col.amount'),
      kind: 'labelled',
      size: 'figure',
      align: 'end',
      cell: (row) => (
        <span
          className={`tabular-nums ${row.direction === 'debit' ? 'text-critical-fg' : 'text-success-fg'}`}
        >
          {row.direction === 'debit' ? '-' : '+'}
          {formatMinor(row.amount, ledger?.currency ?? '', locale)}
        </span>
      ),
    },
    {
      id: 'when',
      header: t('earnings.col.when'),
      kind: 'labelled',
      size: 'zoned-date',
      cell: (row) => <Time iso={row.occurredAt} />,
    },
  ];
  return (
    <DashboardCard
      id="dash-earnings"
      title={t('earnings.title')}
      scope={t('scope.latest', { count: RECENT })}
      action={{ href: '/earnings', label: t('view-all') }}
      flush={rows.length > 0}
      {...(ledger === null ? { error: t('error.card') } : {})}
    >
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="receipt" title={t('earnings.empty')} />
      ) : (
        <ActivityTable
          caption={t('earnings.title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.entryId}
        />
      )}
    </DashboardCard>
  );
}

/** Offers by status: one stacked bar over the offers read for the figures. */
function OfferStates({ data }: { readonly data: SellerDashboardData }) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('catalog.offers.status');
  const page = ok(data.offers);
  if (page === null || page.items.length === 0) return null;
  const more = page.nextAfterId != null;
  const count = (status: string) => page.items.filter((offer) => offer.status === status).length;
  return (
    <DashboardCard
      id="dash-states"
      title={t('states.title')}
      scope={t(more ? 'scope.offers-latest' : 'scope.offers-all', { count: COUNT_LIMIT })}
      action={{ href: '/offers', label: t('view-all') }}
    >
      <DistributionBar
        emptyLabel={t('states.empty')}
        parts={[
          { id: 'published', label: tc('published'), value: count('published'), tone: 'success' },
          {
            id: 'pending',
            label: tc('pending-first-publish'),
            value: count('pending-first-publish'),
            tone: 'info',
          },
          {
            id: 'changes',
            label: tc('changes-needed'),
            value: count('changes-needed'),
            tone: 'attention',
          },
          { id: 'draft', label: tc('draft'), value: count('draft'), tone: 'neutral' },
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
  );
}

/**
 * The seller dashboard (the home page of an approved seller): every widget is present only when
 * the session holds the key its read needs. Order: what needs attention, the latest activity,
 * then quick actions.
 */
export function SellerDashboard({
  data,
  permissionKeys,
}: {
  readonly data: SellerDashboardData;
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
      <Notices data={data} />
      <Attention data={data} />
      <Orders data={data} />
      <LowStock data={data} />
      <Offers data={data} />
      <Earnings data={data} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <OfferStates data={data} />
        <QuickActions keys={keys} />
      </div>
    </div>
  );
}
