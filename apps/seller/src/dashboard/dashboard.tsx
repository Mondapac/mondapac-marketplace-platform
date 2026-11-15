import {
  ActivityCardSkeleton,
  ActivityTable,
  Badge,
  Banner,
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
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { known, OFFER_STATUSES, shortInstant } from '../catalog/format.ts';
import type { OfferView, Page } from '../catalog/types.ts';
import type { Ledger, LedgerEntry } from '../earnings/types.ts';
import type { SellerOrderPage, SellerOrderView } from '../orders/types.ts';
import { PAYOUT_ACCOUNT_PATH, type PayoutAccount } from '../payout/types.ts';
import type { SourcesView } from '../stock/types.ts';
import { formatMinor } from '../price/money.ts';
import {
  COUNT_LIMIT,
  RECENT,
  type LowStockItem,
  type SellerDashboardSources,
  type Widget,
} from './types.ts';

const FULFILMENTS = ['to-ship', 'shipped', 'delivered'] as const;
const LEDGER_KINDS = [
  'sale',
  'shipping',
  'commission',
  'refund-sale',
  'refund-shipping',
  'refund-commission',
  'dispute-debit',
  'dispute-reinstate',
] as const;
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

/** Needs attention figures that come from one read: their skeletons while it runs, then the figures. */
function Figures<T>({
  source,
  cards,
  children,
}: {
  readonly source: Source<T>;
  readonly cards: readonly { readonly icon: IconName; readonly label: string }[];
  readonly children: (widget: Widget<T>) => ReactNode;
}) {
  const { stalledLabel } = useSkeletonText();
  return (
    <DashboardSlot
      source={source}
      fallback={cards.map((card) => (
        <StatCardSkeleton
          key={card.label}
          icon={card.icon}
          label={card.label}
          stalledLabel={stalledLabel}
        />
      ))}
    >
      {(widget) => (widget === null ? null : children(widget))}
    </DashboardSlot>
  );
}

function ToShipFigure({ widget }: { readonly widget: Widget<SellerOrderPage> }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const page = ok(widget);
  const more = page?.nextCursor != null;
  const count = page?.sellerOrders.filter((order) => order.fulfilment === 'to-ship').length ?? 0;
  return (
    <StatCard
      icon="clipboard"
      label={t('attention.to-ship.label')}
      value={formatCount(count, more, locale)}
      scope={t(more ? 'scope.orders-latest' : 'scope.orders-all', { count: COUNT_LIMIT })}
      href="/orders"
      tone={count > 0 ? 'attention' : 'neutral'}
      {...(page === null ? { error: t('error.card') } : {})}
    />
  );
}

function OfferFigures({ widget }: { readonly widget: Widget<Page<OfferView>> }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const failed = t('error.card');
  const page = ok(widget);
  const more = page?.nextAfterId != null;
  const scope = t(more ? 'scope.offers-latest' : 'scope.offers-all', { count: COUNT_LIMIT });
  const count = (status: string) =>
    page?.items.filter((offer) => offer.status === status).length ?? 0;
  return (
    <>
      <StatCard
        icon="inbox"
        label={t('attention.in-review.label')}
        value={formatCount(count('pending-first-publish'), more, locale)}
        scope={scope}
        href="/offers"
        {...(page === null ? { error: failed } : {})}
      />
      <StatCard
        icon="tag"
        label={t('attention.changes.label')}
        value={formatCount(count('changes-needed'), more, locale)}
        scope={scope}
        href="/offers"
        tone={count('changes-needed') > 0 ? 'attention' : 'neutral'}
        {...(page === null ? { error: failed } : {})}
      />
    </>
  );
}

function BalanceFigure({ widget }: { readonly widget: Widget<Ledger> }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const ledger = ok(widget);
  return (
    <StatCard
      icon="wallet"
      label={t('attention.balance.label')}
      value={ledger === null ? '-' : formatMinor(ledger.totals.balance, ledger.currency, locale)}
      scope={t('attention.balance.scope')}
      href="/earnings"
      {...(ledger === null ? { error: t('error.card') } : {})}
    />
  );
}

/** The Needs attention figures; each read loads on its own, and one that failed says so in its cards. */
function Attention({ data }: { readonly data: SellerDashboardSources }) {
  const t = useTranslations('dashboard');
  const cards: ReactNode[] = [];
  if (data.orders !== null) {
    cards.push(
      <Figures
        key="to-ship"
        source={data.orders}
        cards={[{ icon: 'clipboard', label: t('attention.to-ship.label') }]}
      >
        {(widget) => <ToShipFigure widget={widget} />}
      </Figures>,
    );
  }
  if (data.offers !== null) {
    cards.push(
      <Figures
        key="offers"
        source={data.offers}
        cards={[
          { icon: 'inbox', label: t('attention.in-review.label') },
          { icon: 'tag', label: t('attention.changes.label') },
        ]}
      >
        {(widget) => <OfferFigures widget={widget} />}
      </Figures>,
    );
  }
  if (data.ledger !== null) {
    cards.push(
      <Figures
        key="balance"
        source={data.ledger}
        cards={[{ icon: 'wallet', label: t('attention.balance.label') }]}
      >
        {(widget) => <BalanceFigure widget={widget} />}
      </Figures>,
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
  readonly action?: { readonly href: string; readonly label: string };
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
    <ActivitySection source={data.orders} frame={frame} columns={columns}>
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

function useOfferColumns(): ActivityColumn<OfferView>[] {
  const t = useTranslations('dashboard');
  const tc = useTranslations('catalog.offers');
  return [
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
}

function Offers({ data }: { readonly data: SellerDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useOfferColumns();
  if (data.offers === null) return null;
  const frame: Frame = {
    id: 'dash-offers',
    title: t('offers.title'),
    scope: t('scope.offers-open', { count: COUNT_LIMIT }),
    action: { href: '/offers', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.offers} frame={frame} columns={columns} titleLines={2}>
      {(widget) => {
        const page = ok(widget);
        const rows =
          page?.items
            .filter((offer) => (OPEN_OFFERS as readonly string[]).includes(offer.status))
            .slice(0, RECENT) ?? [];
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

function useLowStockColumns(): ActivityColumn<LowStockItem>[] {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  return [
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
}

/** Sell units that are low or out of stock, latest change first; each opens that offer's stock page. */
function LowStock({ data }: { readonly data: SellerDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useLowStockColumns();
  if (data.lowStock === null) return null;
  const frame: Frame = {
    id: 'dash-low-stock',
    title: t('low-stock.title'),
    scope: t('scope.changed-latest'),
  };
  return (
    <ActivitySection source={data.lowStock} frame={frame} columns={columns}>
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
              <EmptyState size="compact" icon="check" title={t('low-stock.empty')} />
            ) : (
              <ActivityTable
                caption={frame.title}
                columns={columns}
                rows={rows}
                rowKey={(row) => `${row.offerId}:${row.variantId}`}
              />
            )}
          </DashboardCard>
        );
      }}
    </ActivitySection>
  );
}

function useEarningColumns(currency: string): ActivityColumn<LedgerEntry>[] {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  return [
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
          {formatMinor(row.amount, currency, locale)}
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
}

function EarningsCard({
  widget,
  frame,
}: {
  readonly widget: Widget<Ledger>;
  readonly frame: Frame;
}) {
  const t = useTranslations('dashboard');
  const ledger = ok(widget);
  const columns = useEarningColumns(ledger?.currency ?? '');
  const rows = ledger?.entries.slice(0, RECENT) ?? [];
  return (
    <DashboardCard
      {...frame}
      flush={rows.length > 0}
      {...(ledger === null ? { error: t('error.card') } : {})}
    >
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="receipt" title={t('earnings.empty')} />
      ) : (
        <ActivityTable
          caption={frame.title}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.entryId}
        />
      )}
    </DashboardCard>
  );
}

function Earnings({ data }: { readonly data: SellerDashboardSources }) {
  const t = useTranslations('dashboard');
  const columns = useEarningColumns('');
  if (data.ledger === null) return null;
  const frame: Frame = {
    id: 'dash-earnings',
    title: t('earnings.title'),
    scope: t('scope.latest', { count: RECENT }),
    action: { href: '/earnings', label: t('view-all') },
  };
  return (
    <ActivitySection source={data.ledger} frame={frame} columns={columns}>
      {(widget) => <EarningsCard widget={widget} frame={frame} />}
    </ActivitySection>
  );
}

/** Offers by status: one stacked bar over the offers read for the figures. */
function OfferStates({ data }: { readonly data: SellerDashboardSources }) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('catalog.offers.status');
  const text = useSkeletonText();
  if (data.offers === null) return null;
  const parts = [
    { id: 'published', label: tc('published'), tone: 'success' },
    { id: 'pending', label: tc('pending-first-publish'), tone: 'info' },
    { id: 'changes', label: tc('changes-needed'), tone: 'attention' },
    { id: 'draft', label: tc('draft'), tone: 'neutral' },
  ] as const;
  const status = {
    published: 'published',
    pending: 'pending-first-publish',
    changes: 'changes-needed',
    draft: 'draft',
  } as const;
  const action = { href: '/offers', label: t('view-all') };
  return (
    <DashboardSlot
      source={data.offers}
      fallback={
        <DistributionCardSkeleton
          id="dash-states"
          title={t('states.title')}
          action={action}
          parts={parts}
          {...text}
        />
      }
    >
      {(widget) => {
        const page = ok(widget);
        if (page === null || page.items.length === 0) return null;
        const more = page.nextAfterId != null;
        const count = (id: keyof typeof status) =>
          page.items.filter((offer) => offer.status === status[id]).length;
        return (
          <DashboardCard
            id="dash-states"
            title={t('states.title')}
            scope={t(more ? 'scope.offers-latest' : 'scope.offers-all', { count: COUNT_LIMIT })}
            action={action}
          >
            <DistributionBar
              emptyLabel={t('states.empty')}
              parts={parts.map((part) => ({ ...part, value: count(part.id) }))}
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
 * then quick actions. Given promises (the page), each card shows its skeleton until its own read
 * answers (panel loading L4).
 */
export function SellerDashboard({
  data,
  permissionKeys,
}: {
  readonly data: SellerDashboardSources;
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
    </DashboardLoading>
  );
}
