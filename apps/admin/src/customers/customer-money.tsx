'use client';

import {
  Banner,
  Button,
  Card,
  EmptyState,
  SkeletonRows,
  SuperTable,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatMinor } from '../wallet/money.ts';
import { CustomerPromotionUsages } from './customer-money-usages.tsx';
import { dayOf } from './format.ts';
import { MoneyList } from './money-list.tsx';
import { DISPUTES_SPEC, PAYMENTS_SPEC, PAYMENTS_VIEW, REFUNDS_SPEC } from './money-lists.tsx';
import {
  ORDERS_VIEW,
  PROMOTIONS_VIEW,
  WALLET_VIEW,
  type CustomerOverview,
  type PromotionCredits,
  type WalletHistory,
} from './page-types.ts';

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'hidden' }
  | { readonly state: 'ready'; readonly body: T };

const WALLET_PAGE = 20;

/** One read of an owning module, with Retry; a failed section leaves the others working. */
/** The newest promotion credits shown; a customer with more sees a note (they are rare). */
const CREDITS_PAGE = 100;

function useRead<T>(path: string | null) {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const latest = useRef(0);
  const run = useCallback(async () => {
    if (path === null) return;
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await callApi<T>('GET', path);
    if (ticket !== latest.current) return;
    if (result.ok) setLoad({ state: 'ready', body: result.body });
    else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setLoad({ state: result.failure.status === 403 ? 'hidden' : 'failed' });
  }, [path]);
  useEffect(() => {
    void run();
  }, [run]);
  return { load, retry: run };
}

function Section({
  title,
  load,
  retry,
  children,
}: {
  readonly title: string;
  readonly load: Load<unknown>;
  readonly retry: () => void;
  readonly children: () => React.ReactNode;
}) {
  const t = useTranslations('customers.page');
  // A 403 hides the section; it is not an error.
  if (load.state === 'hidden') return null;
  return (
    <Card title={title}>
      {load.state === 'loading' ? (
        <SkeletonRows label={t('loading-section', { section: title })} rows={3} />
      ) : load.state === 'failed' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('section-failed', { section: title })}</span>
            <Button variant="secondary" onClick={retry}>
              {t('retry')}
            </Button>
          </div>
        </Banner>
      ) : (
        children()
      )}
    </Card>
  );
}

/**
 * The Money tab of the customer page: three figures (Spent and Refunded from the page, the wallet
 * balance from wallet), then the payments and disputes (payments) and the refunds with their
 * credit notes (ordering) as super lists, the wallet journal (wallet), the promotion credits and
 * the promotion usages (promotions), each under its own key and loaded on its own.
 */
export function CustomerMoney({
  customer,
  keys,
  zone,
  paging,
  walletBalance,
  adminAccountId,
  marketId,
  csrfToken,
}: {
  readonly customer: CustomerOverview;
  readonly keys: ReadonlySet<string>;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  /** The wallet's available balance, or null when it is not shown or could not be read. */
  readonly walletBalance: { readonly available: string; readonly currency: string } | null;
}) {
  const t = useTranslations('customers.page.money');
  const tp = useTranslations('customers.page');
  const locale = useLocale();
  const id = encodeURIComponent(customer.accountId);
  const money = (minor: string, currency: string | null) =>
    currency === null ? '—' : formatMinor(minor, currency, locale);

  const [walletCursors, setWalletCursors] = useState<readonly (string | null)[]>([null]);
  const walletCursor = walletCursors[walletCursors.length - 1] ?? null;
  const wallet = useRead<WalletHistory>(
    keys.has(WALLET_VIEW)
      ? `wallet/admin/customers/${id}/history?limit=${WALLET_PAGE}${walletCursor === null ? '' : `&cursor=${encodeURIComponent(walletCursor)}`}`
      : null,
  );
  const credits = useRead<PromotionCredits>(
    keys.has(PROMOTIONS_VIEW)
      ? `promotions/admin/customers/${id}/credits?limit=${CREDITS_PAGE}`
      : null,
  );

  const figures = [
    { id: 'spent', label: t('figure.spent'), value: money(customer.spentMinor, customer.currency) },
    {
      id: 'refunded',
      label: t('figure.refunded'),
      value: money(customer.refundedMinor, customer.currency),
    },
    ...(keys.has(WALLET_VIEW)
      ? [
          {
            id: 'wallet',
            label: t('figure.wallet'),
            value:
              walletBalance === null ? '—' : money(walletBalance.available, walletBalance.currency),
          },
        ]
      : []),
  ];

  type WalletRow = WalletHistory['entries'][number];
  const walletColumns = (currency: string): SuperColumn<WalletRow>[] => [
    {
      id: 'date',
      header: t('wallet.col.date'),
      primary: true,
      cell: (row) => <span className="font-medium">{dayOf(row.createdAt, locale, zone)}</span>,
    },
    {
      id: 'kind',
      header: t('wallet.col.kind'),
      cell: (row) => (t.has(`wallet.kind.${row.kind}`) ? t(`wallet.kind.${row.kind}`) : row.kind),
    },
    {
      id: 'amount',
      header: t('wallet.col.amount'),
      numeric: true,
      cell: (row) => {
        const negative = row.amount.startsWith('-');
        const shown = formatMinor(negative ? row.amount.slice(1) : row.amount, currency, locale);
        return negative ? `−${shown}` : `+${shown}`;
      },
    },
    {
      id: 'reason',
      header: t('wallet.col.reason'),
      cell: (row) =>
        row.reasonCode === null ? (
          <span className="text-fg-muted">—</span>
        ) : t.has(`wallet.reason.${row.reasonCode}`) ? (
          t(`wallet.reason.${row.reasonCode}`)
        ) : (
          row.reasonCode
        ),
    },
  ];

  type CreditRow = PromotionCredits['items'][number];
  const creditColumns: SuperColumn<CreditRow>[] = [
    {
      id: 'issued',
      header: t('credits.col.issued'),
      primary: true,
      cell: (row) => <span className="font-medium">{dayOf(row.createdAt, locale, zone)}</span>,
    },
    {
      id: 'kind',
      header: t('credits.col.kind'),
      cell: (row) => (t.has(`credits.kind.${row.kind}`) ? t(`credits.kind.${row.kind}`) : row.kind),
    },
    {
      id: 'status',
      header: t('credits.col.status'),
      cell: (row) =>
        t.has(`credits.status.${row.status}`) ? t(`credits.status.${row.status}`) : row.status,
    },
    {
      id: 'amount',
      header: t('credits.col.amount'),
      numeric: true,
      cell: (row) => formatMinor(row.amountMinor, row.currency, locale),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label={t('figures')} className="grid gap-3 sm:grid-cols-3">
        {figures.map((figure) => (
          <li
            key={figure.id}
            className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-4"
          >
            <span className="text-sm font-medium text-fg-secondary">{figure.label}</span>
            <span className="text-2xl font-semibold tabular-nums">{figure.value}</span>
          </li>
        ))}
      </ul>
      {keys.has(PAYMENTS_VIEW) ? (
        <MoneyList
          spec={PAYMENTS_SPEC}
          accountId={customer.accountId}
          adminAccountId={adminAccountId}
          marketId={marketId}
          keys={keys}
          csrfToken={csrfToken}
          zone={zone}
          paging={paging}
        />
      ) : null}
      {keys.has(PAYMENTS_VIEW) ? (
        <MoneyList
          spec={DISPUTES_SPEC}
          accountId={customer.accountId}
          adminAccountId={adminAccountId}
          marketId={marketId}
          keys={keys}
          csrfToken={csrfToken}
          zone={zone}
          paging={paging}
        />
      ) : null}
      {keys.has(ORDERS_VIEW) ? (
        <MoneyList
          spec={REFUNDS_SPEC}
          accountId={customer.accountId}
          adminAccountId={adminAccountId}
          marketId={marketId}
          keys={keys}
          csrfToken={csrfToken}
          zone={zone}
          paging={paging}
        />
      ) : null}
      {keys.has(WALLET_VIEW) ? (
        <Section title={t('wallet.title')} load={wallet.load} retry={() => void wallet.retry()}>
          {() => {
            if (wallet.load.state !== 'ready') return null;
            const body = wallet.load.body;
            const page = walletCursors.length;
            return (
              <div className="flex flex-col gap-3">
                <SuperTable
                  caption={t('wallet.title')}
                  rows={body.entries}
                  rowId={(row) => row.journalId}
                  rowName={(row) => row.journalId}
                  columns={walletColumns(body.currency)}
                  empty={<EmptyState size="compact" icon="wallet" title={t('wallet.empty')} />}
                />
                {page > 1 || body.nextCursor !== null ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-fg-muted">{t('wallet.page', { page })}</p>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        disabled={page <= 1}
                        onClick={() => setWalletCursors((current) => current.slice(0, -1))}
                      >
                        {tp('paging.previous')}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={body.nextCursor === null}
                        onClick={() => setWalletCursors((current) => [...current, body.nextCursor])}
                      >
                        {tp('paging.next')}
                      </Button>
                    </div>
                  </div>
                ) : null}
                <p>
                  <a
                    className="text-sm font-medium text-link underline"
                    href={`/wallet/credits?customer=${id}`}
                  >
                    {t('wallet.open')}
                  </a>
                </p>
              </div>
            );
          }}
        </Section>
      ) : null}
      {keys.has(PROMOTIONS_VIEW) ? (
        <Section title={t('credits.title')} load={credits.load} retry={() => void credits.retry()}>
          {() =>
            credits.load.state !== 'ready' ? null : (
              <div className="flex flex-col gap-3">
                <SuperTable
                  caption={t('credits.title')}
                  rows={credits.load.body.items}
                  rowId={(row) => row.id}
                  rowName={(row) => row.id}
                  columns={creditColumns}
                  empty={<EmptyState size="compact" icon="tag" title={t('credits.empty')} />}
                />
                {credits.load.body.nextCursor === null ? null : (
                  <p className="text-sm text-fg-muted">
                    {t('credits.capped', { max: CREDITS_PAGE })}
                  </p>
                )}
              </div>
            )
          }
        </Section>
      ) : null}
      {keys.has(PROMOTIONS_VIEW) ? (
        <CustomerPromotionUsages accountId={customer.accountId} zone={zone} />
      ) : null}
    </div>
  );
}
