'use client';

import {
  Badge,
  Banner,
  BackLink,
  Button,
  Card,
  DataList,
  IconButton,
  LinkButton,
  Menu,
  SkeletonRows,
  Tabs,
  tabIdOf,
  useMediaQuery,
  type MenuItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BuyerDeletion } from '../account-deletion/buyer-deletion.tsx';
import { callApi } from '../api/client.ts';
import { OrdersList } from '../orders/orders-list.tsx';
import { numberFormat } from '../shared/intl.ts';
import { formatMinor } from '../wallet/money.ts';
import { RecentActivity } from './customer-activity.tsx';
import { CustomerEditDialog } from './customer-edit.tsx';
import {
  CancelEmailChangeDialog,
  CustomerEmailDialog,
  PendingEmailBanner,
  type PendingEmailChange,
} from './customer-email.tsx';
import { CustomerGroupsCard } from './customer-groups-card.tsx';
import { CustomerMoney } from './customer-money.tsx';
import { CustomerNotes } from './customer-notes.tsx';
import { CustomerStatusDialog, type StatusTarget } from './customer-status.tsx';
import { copyText } from './customers-list.tsx';
import { dayOf } from './format.ts';
import { CUSTOMER_EDIT } from './groups-types.ts';
import { STATUS_PERMISSION, titleOf } from './list-types.ts';
import {
  BUYER_DELETE,
  EMAIL_CHANGE,
  WALLET_ISSUE,
  WALLET_VIEW,
  averageMinor,
  tabsFor,
  type CustomerOverview,
  type Tab,
} from './page-types.ts';

/** An erased customer's page: the id and when, nothing else. */
interface CustomerTombstone {
  readonly accountId: string;
  readonly status: 'deleted';
  readonly deletedAt: string;
}

const isTombstone = (body: CustomerOverview | CustomerTombstone): body is CustomerTombstone =>
  body.status === 'deleted' && 'deletedAt' in body;

type PageLoad =
  | { readonly state: 'loading' }
  | { readonly state: 'not-found' }
  | { readonly state: 'deleted'; readonly deletedAt: string }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly customer: CustomerOverview };

type TabAudit = 'pending' | 'ok' | 'failed';

/** The one panel the tab row switches (ARIA tabs). */
const PANEL_ID = 'customer-tab-panel';

/** A figure of the Overview: what is counted, the value, and a muted line under it. */
function Tile({
  label,
  value,
  muted = false,
  note,
  wide = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly muted?: boolean;
  readonly note?: string;
  /** Spans two columns, so an odd last tile leaves no empty cell. */
  readonly wide?: boolean;
}) {
  return (
    <li
      className={`flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-4 ${wide ? 'col-span-2' : ''}`}
    >
      <span className="text-sm font-medium text-fg-secondary">{label}</span>
      <span
        className={`text-xl font-semibold tabular-nums wrap-anywhere ${muted ? 'text-fg-muted' : 'text-fg'}`}
      >
        {value}
      </span>
      {note === undefined ? null : <span className="text-xs text-fg-muted">{note}</span>}
    </li>
  );
}

/**
 * One customer for an admin (customers management phase 1, F2): the header with the profile and
 * the account actions, then the Overview, Orders and Money tabs. Opening the page reads the
 * Overview, which the API audits; a page whose read fails (and so could not be audited) is not
 * shown. Orders and Money record their opening (`tab-opened`) once per visit before their data is
 * read from the owning module, each under its own key. The tab is in the address (`?tab=`), so a
 * reload, a deep link and Back from an order come back to it.
 */
export function CustomerPage({
  accountId,
  adminAccountId,
  marketId,
  initialTab,
  permissionKeys,
  csrfToken,
  zone,
  paging,
  waitingPeriodDays,
}: {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly initialTab: Tab;
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly waitingPeriodDays: number | null;
}) {
  const t = useTranslations('customers.page');
  const tc = useTranslations('customers');
  const tl = useTranslations('customers.list');
  const locale = useLocale();
  const keys = new Set(permissionKeys);
  const tabs = tabsFor(keys);
  const [tab, setTab] = useState<Tab>(tabs.includes(initialTab) ? initialTab : 'overview');
  const [page, setPage] = useState<PageLoad>({ state: 'loading' });
  const [audits, setAudits] = useState<Partial<Record<Tab, TabAudit>>>({});
  const [wallet, setWallet] = useState<
    { readonly available: string; readonly currency: string } | null | 'failed' | 'off'
  >(null);
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);
  const [deleteSignal, setDeleteSignal] = useState(0);
  const [pendingDeletion, setPendingDeletion] = useState(false);
  const [editing, setEditing] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [cancelEmailOpen, setCancelEmailOpen] = useState(false);
  // Bumped when the page did something that lands on the timeline (a note, a group, a rename).
  const [activityRefresh, setActivityRefresh] = useState(0);
  // On a phone, Edit… moves into the More menu (Reza, 16 Nov).
  const wide = useMediaQuery('(min-width: 40rem)');
  const panel = useRef<HTMLDivElement>(null);
  const id = encodeURIComponent(accountId);
  const pendingChanged = useCallback(
    (pending: { readonly requestId: string } | null) => setPendingDeletion(pending !== null),
    [],
  );

  const load = useCallback(async () => {
    setPage({ state: 'loading' });
    const result = await callApi<CustomerOverview | CustomerTombstone>(
      'GET',
      `customers/admin/customers/${id}`,
    );
    if (result.ok) {
      const body = result.body;
      if (isTombstone(body)) {
        // The account was erased: the API answers only when (phase 2b tombstone).
        setPage({ state: 'deleted', deletedAt: body.deletedAt });
        return;
      }
      setPendingDeletion((body.deletionRequest ?? null) !== null);
      setPage({ state: 'ready', customer: body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setPage({
      state:
        result.failure.code === 'customers.customer-not-found' ||
        result.failure.code === 'validation.failed'
          ? 'not-found'
          : 'failed',
    });
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Reads the header and Overview again without the loading state (after a group change). */
  const refresh = useCallback(async () => {
    const result = await callApi<CustomerOverview>('GET', `customers/admin/customers/${id}`);
    if (result.ok) {
      setPage((current) =>
        current.state === 'ready' ? { state: 'ready', customer: result.body } : current,
      );
    }
    setActivityRefresh((value) => value + 1);
  }, [id]);

  // The wallet balance (Overview tile and Money figure), from wallet, under its own key.
  useEffect(() => {
    if (!keys.has(WALLET_VIEW)) return;
    let live = true;
    void callApi<{ available: string; currency: string }>(
      'GET',
      `wallet/admin/customers/${id}`,
    ).then((result) => {
      if (!live) return;
      setWallet(
        result.ok
          ? { available: result.body.available, currency: result.body.currency }
          : // The Market's wallet is switched off: there is no balance to show, and no error.
            result.failure.code === 'wallet.disabled'
            ? 'off'
            : 'failed',
      );
    });
    return () => {
      live = false;
    };
    // The key set is fixed for the page's life.
  }, [id]);

  // Orders and Money: the opening is audited once per visit, before their data is read.
  useEffect(() => {
    if (tab === 'overview' || page.state !== 'ready' || audits[tab] !== undefined) return;
    setAudits((current) => ({ ...current, [tab]: 'pending' }));
    void callApi('POST', `customers/admin/customers/${id}/tab-opened`, { tab }, csrfToken).then(
      (result) => setAudits((current) => ({ ...current, [tab]: result.ok ? 'ok' : 'failed' })),
    );
  }, [tab, page.state, audits, id, csrfToken]);

  const select = (next: string) => {
    const chosen = next as Tab;
    setTab(chosen);
    const url = new URL(window.location.href);
    if (chosen === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', chosen);
    window.history.replaceState(null, '', url);
    // The panel takes the focus, so a keyboard user lands on the tab's content.
    requestAnimationFrame(() => panel.current?.focus());
  };

  const back = <BackLink href="/customers" label={t('back')} />;

  if (page.state === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <SkeletonRows label={t('loading')} rows={5} />
      </div>
    );
  }
  if (page.state === 'not-found') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Banner tone="info" title={t('not-found.title')}>
          {t('not-found.body')}
        </Banner>
      </div>
    );
  }
  if (page.state === 'deleted') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Banner tone="info" title={t('deleted.title')}>
          {t('deleted.body', { date: dayOf(page.deletedAt, locale, zone) })}
        </Banner>
      </div>
    );
  }
  if (page.state === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Banner tone="critical" title={t('failed.title')}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('failed.body')}</span>
            <Button variant="secondary" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        </Banner>
      </div>
    );
  }

  const { customer } = page;
  const title = titleOf(customer);
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const money = (minor: string | null) =>
    minor === null || customer.currency === null
      ? '—'
      : formatMinor(minor, customer.currency, locale);
  const active = customer.status === 'active';
  const walletShown =
    keys.has(WALLET_VIEW) && wallet !== null && wallet !== 'failed' && wallet !== 'off'
      ? wallet
      : null;
  const walletTile = keys.has(WALLET_VIEW) && wallet !== 'off';

  const canEdit = keys.has(CUSTOMER_EDIT);
  const pendingEmail = customer.pendingEmailChange ?? null;
  const setPendingEmail = (change: PendingEmailChange | null) =>
    setPage((current) =>
      current.state === 'ready'
        ? { state: 'ready', customer: { ...current.customer, pendingEmailChange: change } }
        : current,
    );
  const more: MenuItem[] = [
    ...(canEdit && !wide
      ? [{ id: 'edit', label: t('header.edit'), onSelect: () => setEditing(true) }]
      : []),
    ...(keys.has(EMAIL_CHANGE)
      ? [
          {
            id: 'email',
            label:
              pendingEmail === null ? t('header.edit-email') : t('header.change-pending-email'),
            onSelect: () => setEmailOpen(true),
          },
        ]
      : []),
    ...(keys.has(STATUS_PERMISSION)
      ? [
          {
            id: 'status',
            label: active ? tl('row.disable') : tl('row.enable'),
            icon: active ? ('ban' as const) : ('check' as const),
            ...(active ? { tone: 'critical' as const } : {}),
            onSelect: () =>
              setStatusTarget({ accountId, email: customer.email, status: customer.status }),
          },
        ]
      : []),
    ...(keys.has(BUYER_DELETE) && !pendingDeletion
      ? [
          {
            id: 'delete',
            label: t('header.delete'),
            icon: 'trash' as const,
            tone: 'critical' as const,
            onSelect: () => setDeleteSignal((value) => value + 1),
          },
        ]
      : []),
  ];

  const refundNote = t('overview.refund-count', { count: customer.refundCount });
  const average = averageMinor(customer.spentMinor, customer.orderCount);

  return (
    <div className="flex flex-col gap-4">
      {back}
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-2xl font-semibold wrap-anywhere">{title}</h1>
            <div className="flex min-w-0 items-center gap-1">
              <span className="text-fg-muted wrap-anywhere">{customer.email}</span>
              <IconButton
                icon="clipboard"
                label={tl('row.copy-email')}
                onClick={() => void copyText(customer.email, tl('copied'), tl('copy-failed'))}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={active ? 'success' : 'critical'}>
                {tc(`status.${customer.status}`)}
              </Badge>
              <Badge tone="neutral">
                {customer.emailVerified ? t('header.verified') : t('header.not-verified')}
              </Badge>
              {pendingDeletion ? (
                <Badge tone="attention">{t('header.deletion-pending')}</Badge>
              ) : null}
              {pendingEmail === null ? null : (
                <Badge tone="attention">{t('header.email-pending')}</Badge>
              )}
              <span className="text-sm text-fg-muted">
                {t('header.joined', { date: dayOf(customer.signedUpAt, locale, zone) })}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {keys.has(WALLET_ISSUE) ? (
              <LinkButton variant="secondary" href={`/wallet/credits?customer=${id}`}>
                {t('header.issue-credit')}
              </LinkButton>
            ) : keys.has(WALLET_VIEW) ? (
              <LinkButton variant="secondary" href={`/wallet/credits?customer=${id}`}>
                {t('header.view-wallet')}
              </LinkButton>
            ) : null}
            {canEdit && wide ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('header.edit')}
              </Button>
            ) : null}
            {more.length === 0 ? null : (
              <Menu label={t('header.more')} icon="more-horizontal" items={more} />
            )}
          </div>
        </div>
        {keys.has(BUYER_DELETE) ? (
          <BuyerDeletion
            accountId={accountId}
            waitingPeriodDays={waitingPeriodDays}
            csrfToken={csrfToken}
            openSignal={deleteSignal}
            onPendingChange={pendingChanged}
            existing={customer.deletionRequest ?? null}
            zone={zone}
          />
        ) : null}
      </Card>
      {pendingEmail === null ? null : (
        <PendingEmailBanner
          pending={pendingEmail}
          zone={zone}
          canCancel={keys.has(EMAIL_CHANGE)}
          onCancel={() => setCancelEmailOpen(true)}
        />
      )}
      {tabs.length > 1 ? (
        <Tabs
          label={t('tabs')}
          activeId={tab}
          onSelect={select}
          panelId={PANEL_ID}
          items={tabs.map((item) => ({ id: item, label: t(`tab.${item}`) }))}
        />
      ) : null}
      <div
        ref={panel}
        id={PANEL_ID}
        tabIndex={-1}
        {...(tabs.length > 1
          ? { role: 'tabpanel', 'aria-labelledby': tabIdOf(PANEL_ID, tab) }
          : { role: 'region', 'aria-label': t(`tab.${tab}`) })}
        className="focus:outline-none"
      >
        {tab === 'overview' ? (
          <div className="flex flex-col gap-4">
            <ul
              aria-label={t('overview.figures')}
              className="grid grid-cols-2 gap-3 lg:grid-cols-3"
            >
              <Tile label={t('overview.orders')} value={number(customer.orderCount)} />
              <Tile
                label={t('overview.spent')}
                value={money(customer.orderCount === 0 ? null : customer.spentMinor)}
              />
              <Tile label={t('overview.average')} value={money(average)} />
              <Tile
                label={t('overview.refunds')}
                value={money(customer.refundCount === 0 ? null : customer.refundedMinor)}
                note={refundNote}
              />
              {walletTile ? (
                <Tile
                  label={t('overview.wallet')}
                  value={
                    wallet === 'failed'
                      ? t('overview.wallet-failed')
                      : walletShown === null
                        ? '—'
                        : formatMinor(walletShown.available, walletShown.currency, locale)
                  }
                  muted={wallet === 'failed'}
                />
              ) : null}
              <Tile
                label={t('overview.last-order')}
                value={
                  customer.lastOrderAt === null
                    ? tl('never')
                    : dayOf(customer.lastOrderAt, locale, zone)
                }
                muted={customer.lastOrderAt === null}
                {...(customer.firstOrderAt === null
                  ? {}
                  : {
                      note: t('overview.first-order-on', {
                        date: dayOf(customer.firstOrderAt, locale, zone),
                      }),
                    })}
                wide={!walletTile}
              />
            </ul>
            <CustomerGroupsCard
              accountId={accountId}
              groups={customer.groups ?? []}
              keys={keys}
              csrfToken={csrfToken}
              onChanged={() => void refresh()}
            />
            <CustomerNotes
              accountId={accountId}
              keys={keys}
              csrfToken={csrfToken}
              zone={zone}
              onAdded={() => setActivityRefresh((value) => value + 1)}
            />
            <RecentActivity
              accountId={accountId}
              adminAccountId={adminAccountId}
              marketId={marketId}
              keys={keys}
              csrfToken={csrfToken}
              zone={zone}
              paging={paging}
              refresh={activityRefresh}
            />
            <Card title={t('overview.profile')}>
              <DataList
                missing={t('overview.not-given')}
                rows={[
                  {
                    label: t('overview.email'),
                    value: <span className="wrap-anywhere">{customer.email}</span>,
                  },
                  { label: t('overview.name'), value: customer.displayName },
                  { label: t('overview.status'), value: tc(`status.${customer.status}`) },
                  {
                    label: t('overview.verified'),
                    value: tc(customer.emailVerified ? 'yes' : 'no'),
                  },
                  { label: t('overview.joined'), value: dayOf(customer.signedUpAt, locale, zone) },
                  {
                    label: t('overview.account-id'),
                    value: (
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="font-mono text-xs wrap-anywhere">
                          {customer.accountId}
                        </span>
                        <IconButton
                          icon="clipboard"
                          label={tl('row.copy-id')}
                          onClick={() =>
                            void copyText(customer.accountId, tl('copied'), tl('copy-failed'))
                          }
                        />
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
          </div>
        ) : audits[tab] === 'failed' ? (
          <Banner tone="critical">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{t('tab-failed')}</span>
              <Button
                variant="secondary"
                onClick={() =>
                  setAudits((current) => {
                    const next = { ...current };
                    delete next[tab];
                    return next;
                  })
                }
              >
                {t('retry')}
              </Button>
            </div>
          </Banner>
        ) : audits[tab] !== 'ok' ? (
          <SkeletonRows label={t('loading-section', { section: t(`tab.${tab}`) })} rows={4} />
        ) : tab === 'orders' ? (
          <OrdersList
            paging={paging}
            accountId={adminAccountId}
            marketId={marketId}
            csrfToken={csrfToken}
            zone={zone}
            customerAccountId={accountId}
          />
        ) : (
          <CustomerMoney
            customer={customer}
            keys={keys}
            zone={zone}
            paging={paging}
            walletBalance={walletShown}
          />
        )}
      </div>
      <CustomerEditDialog
        open={editing}
        accountId={accountId}
        email={customer.email}
        displayName={customer.displayName}
        csrfToken={csrfToken}
        onClose={() => setEditing(false)}
        onSaved={(displayName) => {
          setPage((current) =>
            current.state === 'ready'
              ? { state: 'ready', customer: { ...current.customer, displayName } }
              : current,
          );
          setActivityRefresh((value) => value + 1);
        }}
      />
      <CustomerEmailDialog
        open={emailOpen}
        accountId={accountId}
        email={customer.email}
        pending={pendingEmail}
        csrfToken={csrfToken}
        onClose={() => setEmailOpen(false)}
        onSent={(change) => {
          setPendingEmail(change);
          setActivityRefresh((value) => value + 1);
        }}
      />
      <CancelEmailChangeDialog
        open={cancelEmailOpen}
        accountId={accountId}
        pending={pendingEmail}
        csrfToken={csrfToken}
        onClose={() => setCancelEmailOpen(false)}
        onCancelled={() => {
          setPendingEmail(null);
          setActivityRefresh((value) => value + 1);
        }}
      />
      <CustomerStatusDialog
        target={statusTarget}
        csrfToken={csrfToken}
        onClose={() => setStatusTarget(null)}
        onChanged={(status) =>
          setPage((current) =>
            current.state === 'ready'
              ? { state: 'ready', customer: { ...current.customer, status } }
              : current,
          )
        }
      />
    </div>
  );
}
