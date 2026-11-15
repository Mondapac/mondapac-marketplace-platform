'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ListPagination,
  SkeletonRows,
  SuperTable,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { formatMinor } from '../wallet/money.ts';
import { dayOf } from './format.ts';
import {
  ORDERS_VIEW,
  PROMOTIONS_VIEW,
  REFUNDS_CAP,
  WALLET_VIEW,
  type CustomerOverview,
  type CustomerRefunds,
  type PromotionCredits,
  type WalletHistory,
} from './page-types.ts';

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly body: T };

const REFUND_PAGE = 25;
const WALLET_PAGE = 20;

/** One read of an owning module, with Retry; a failed section leaves the others working. */
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
    else setLoad({ state: 'failed' });
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
 * balance from wallet), then the refunds with their credit notes (ordering), the wallet journal
 * (wallet) and the promotion credits (promotions), each under its own key and loaded on its own.
 * Payments per order, chargebacks and code usage have no read yet (phase 2 backend).
 */
export function CustomerMoney({
  customer,
  keys,
  zone,
  paging,
  walletBalance,
}: {
  readonly customer: CustomerOverview;
  readonly keys: ReadonlySet<string>;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  /** The wallet's available balance, or null when it is not shown or could not be read. */
  readonly walletBalance: { readonly available: string; readonly currency: string } | null;
}) {
  const t = useTranslations('customers.page.money');
  const tp = useTranslations('customers.page');
  const locale = useLocale();
  const id = encodeURIComponent(customer.accountId);
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const money = (minor: string, currency: string | null) =>
    currency === null ? '—' : formatMinor(minor, currency, locale);

  const refunds = useRead<CustomerRefunds>(
    keys.has(ORDERS_VIEW) ? `ordering/admin/customers/${id}/refunds` : null,
  );
  const [refundPage, setRefundPage] = useState(1);
  const [walletCursors, setWalletCursors] = useState<readonly (string | null)[]>([null]);
  const walletCursor = walletCursors[walletCursors.length - 1] ?? null;
  const wallet = useRead<WalletHistory>(
    keys.has(WALLET_VIEW)
      ? `wallet/admin/customers/${id}/history?limit=${WALLET_PAGE}${walletCursor === null ? '' : `&cursor=${encodeURIComponent(walletCursor)}`}`
      : null,
  );
  const credits = useRead<PromotionCredits>(
    keys.has(PROMOTIONS_VIEW) ? `promotions/admin/customers/${id}/credits?limit=50` : null,
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

  type RefundRow = CustomerRefunds['refunds'][number];
  const refundColumns: SuperColumn<RefundRow>[] = [
    {
      id: 'order',
      header: t('refunds.col.order'),
      primary: true,
      cell: (row) => (
        <a
          className="font-medium text-link underline wrap-anywhere"
          href={`/orders/${encodeURIComponent(row.orderId)}`}
        >
          {t('refunds.order', { id: row.orderId.slice(0, 8) })}
        </a>
      ),
    },
    {
      id: 'state',
      header: t('refunds.col.state'),
      corner: true,
      cell: (row) => (
        <Badge
          tone={
            row.state === 'succeeded'
              ? 'success'
              : row.state === 'failed'
                ? 'critical'
                : 'attention'
          }
        >
          {t.has(`refunds.state.${row.state}`) ? t(`refunds.state.${row.state}`) : row.state}
        </Badge>
      ),
    },
    {
      id: 'amount',
      header: t('refunds.col.amount'),
      numeric: true,
      cell: (row) => formatMinor(row.amount.amount, row.amount.currency, locale),
    },
    {
      id: 'requested',
      header: t('refunds.col.requested'),
      cell: (row) => dayOf(row.requestedAt, locale, zone),
    },
    {
      id: 'credit-note',
      header: t('refunds.col.credit-note'),
      cell: (row) =>
        row.creditNoteId === null ? (
          <span className="text-fg-muted">{t('refunds.no-credit-note')}</span>
        ) : (
          <span className="font-mono text-xs wrap-anywhere">{row.creditNoteId}</span>
        ),
    },
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

  const pagingLabels = {
    rowsPerPage: tp('paging.rows-per-page'),
    previous: tp('paging.previous'),
    next: tp('paging.next'),
    pages: tp('paging.pages'),
    page: (page: number) => tp('paging.page', { page }),
    narrowTitle: tp('paging.narrow-title'),
    narrowBody: tp('paging.narrow-body'),
  };

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
      {keys.has(ORDERS_VIEW) ? (
        <Section title={t('refunds.title')} load={refunds.load} retry={() => void refunds.retry()}>
          {() => {
            if (refunds.load.state !== 'ready') return null;
            const all = refunds.load.body.refunds;
            const rows = all.slice((refundPage - 1) * REFUND_PAGE, refundPage * REFUND_PAGE);
            return (
              <div className="flex flex-col gap-3">
                <SuperTable
                  caption={t('refunds.title')}
                  rows={rows}
                  rowId={(row) => row.refundId}
                  rowName={(row) => row.orderId}
                  columns={refundColumns}
                  empty={<EmptyState size="compact" icon="receipt" title={t('refunds.empty')} />}
                />
                {all.length > REFUND_PAGE ? (
                  <ListPagination
                    mode={paging}
                    page={refundPage}
                    pageSize={REFUND_PAGE}
                    pageSizes={[REFUND_PAGE]}
                    total={all.length}
                    maxRows={REFUNDS_CAP}
                    range={tp('range', {
                      from: number((refundPage - 1) * REFUND_PAGE + 1),
                      to: number((refundPage - 1) * REFUND_PAGE + rows.length),
                      total: number(all.length),
                    })}
                    labels={pagingLabels}
                    onPage={setRefundPage}
                    onPageSize={() => undefined}
                  />
                ) : null}
                {all.length >= REFUNDS_CAP ? (
                  <p className="text-sm text-fg-muted">
                    {t('refunds.capped', { max: REFUNDS_CAP })}
                  </p>
                ) : null}
              </div>
            );
          }}
        </Section>
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
              <SuperTable
                caption={t('credits.title')}
                rows={credits.load.body.items}
                rowId={(row) => row.id}
                rowName={(row) => row.id}
                columns={creditColumns}
                empty={<EmptyState size="compact" icon="tag" title={t('credits.empty')} />}
              />
            )
          }
        </Section>
      ) : null}
      <p className="text-sm text-fg-muted">{t('not-yet')}</p>
    </div>
  );
}
