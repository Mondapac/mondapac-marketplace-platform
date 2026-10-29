'use client';

import {
  BackLink,
  Banner,
  Button,
  Card,
  CARD_TABLE,
  DataList,
  type DataListRow,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { formatMinor } from '../wallet/money.ts';
import { ApproveDialog } from './approve-dialog.tsx';
import { StateBadge } from './state-badge.tsx';
import { bankWaitUntil, type PayoutDetail, type PayoutMoney } from './types.ts';

const OUTCOMES = [
  'payout-unwound',
  'transfer-failed',
  'transfer-refused',
  'voided.hold',
  'voided.amount-changed',
  'voided.access',
  'voided.account-not-ready',
  'voided.second-factor',
] as const;

/**
 * One payout for an admin: the summary, the account and the limits an approver needs, the
 * approval and the seller orders taken. The payout is read by the page server; an approval reads
 * it again from the relay, and nothing on screen is guessed.
 */
export function PayoutDetailView({
  initial,
  zone,
  canApprove,
  accountId,
  csrfToken,
}: {
  readonly initial: PayoutDetail;
  readonly zone: string;
  /** The session holds commission-payouts.payout.approve (the API decides again). */
  readonly canApprove: boolean;
  readonly accountId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('payouts');
  const locale = useLocale();
  const [detail, setDetail] = useState(initial);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<'approved' | 'stale' | null>(null);
  const [now] = useState(() => Date.now());
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  const money = (value: PayoutMoney) => formatMinor(value.amountMinor, value.currency, locale);
  const when = (iso: string) => shortInstantInZone(iso, locale, zone);
  const name = detail.storeName ?? t('unnamed', { id: shortId(detail.sellerId) });
  const waiting = detail.state === 'awaiting-approval';
  const wait = waiting ? bankWaitUntil(detail, now) : null;

  async function refresh(): Promise<boolean> {
    const result = await callApi<PayoutDetail>(
      'GET',
      `commission-payouts/admin/payouts/${encodeURIComponent(detail.payoutId)}`,
    );
    if (result.ok) {
      setDetail(result.body);
      return true;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    return false;
  }

  function approved() {
    setOpen(false);
    void refresh().then((ok) => setNotice(ok ? 'approved' : 'stale'));
  }

  const outcome =
    detail.outcomeCode === null
      ? null
      : (OUTCOMES as readonly string[]).includes(detail.outcomeCode)
        ? // Keys cannot hold a dot: `voided.hold` is `voided-hold`.
          t(`outcome.${detail.outcomeCode.replace('.', '-')}` as 'outcome.payout-unwound')
        : t('outcome.refused', { code: detail.outcomeCode });

  const summary: DataListRow[] = [
    {
      label: t('summary.seller'),
      value: (
        <a className="font-medium text-link underline" href={`/sellers/${detail.sellerId}`}>
          {name}
        </a>
      ),
    },
    { label: t('summary.state'), value: <StateBadge state={detail.state} /> },
    { label: t('summary.gross'), value: money(detail.gross) },
    { label: t('summary.netted'), value: money(detail.netted) },
    { label: t('summary.transfer'), value: money(detail.transfer) },
    {
      label: t('summary.approval'),
      value:
        detail.approvalMode === 'AUTO' || detail.approvalReason === null
          ? t('why.auto')
          : t(`why.${detail.approvalReason}`),
    },
    { label: t('summary.slot'), value: when(detail.slotAt) },
    { label: t('summary.created'), value: when(detail.createdAt) },
    { label: t('summary.changed'), value: when(detail.stateChangedAt) },
    { label: t('summary.outcome'), value: outcome },
  ];

  const limits = detail.limits;
  const account: DataListRow[] = [
    { label: t('account.readiness'), value: t(`account.${detail.accountReadiness}`) },
    {
      label: t('account.bank-changed'),
      value:
        detail.lastBankChangeAt === null
          ? t('account.bank-changed-none')
          : when(detail.lastBankChangeAt),
    },
    ...(limits === null
      ? []
      : [
          { label: t('account.per-transfer'), value: money(limits.perTransfer) },
          {
            label: t('account.today'),
            value: t('account.today-value', {
              total: money(limits.todayTotal),
              level: money(limits.dailyAlertLevel),
            }),
          },
        ]),
  ];

  const approval = detail.approval;
  return (
    <div className="flex flex-col gap-4">
      <BackLink href="/payouts" label={t('title')} />
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-words text-2xl font-semibold">
          {t('detail.title', { id: shortId(detail.payoutId) })}
        </h1>
        <StateBadge state={detail.state} />
      </div>
      {notice === null ? null : (
        <div ref={noticeRef} tabIndex={-1}>
          <Banner tone={notice === 'approved' ? 'success' : 'attention'}>
            {t(notice === 'approved' ? 'approve.done' : 'approve.done-stale')}
          </Banner>
        </div>
      )}
      {wait !== null ? (
        <Banner tone="attention">{t('bank-wait', { until: when(wait) })}</Banner>
      ) : null}
      {limits?.overDailyAlertLevel === true && waiting ? (
        <Banner tone="attention">{t('approve.over-level')}</Banner>
      ) : null}
      <Card title={t('summary.title')}>
        <DataList missing="-" rows={summary} />
        <p className="text-sm text-fg-muted">{t('zone-note', { zone })}</p>
        {waiting && canApprove && wait === null ? (
          <div>
            <Button
              onClick={() => {
                setNotice(null);
                setOpen(true);
              }}
            >
              {t('approve-action', { amount: money(detail.transfer) })}
            </Button>
          </div>
        ) : null}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('account.title')}>
          <DataList missing="-" rows={account} />
        </Card>
        <Card title={t('approval.title')}>
          {approval === null ? (
            <p className="text-fg-muted">{t(waiting ? 'approval.waiting' : 'approval.none')}</p>
          ) : (
            <DataList
              missing="-"
              rows={[
                {
                  label: t('approval.by'),
                  value:
                    approval.approvedBy === accountId
                      ? t('you')
                      : t('another-admin', { id: shortId(approval.approvedBy) }),
                },
                { label: t('approval.at'), value: when(approval.approvedAt) },
                { label: t('approval.amount'), value: money(approval.approvedTransfer) },
              ]}
            />
          )}
        </Card>
      </div>
      <Card title={t('items.title')}>
        <p className="text-sm text-fg-muted">{t('items.note')}</p>
        {detail.items.length === 0 ? (
          <p className="text-fg-muted">{t('items.none')}</p>
        ) : (
          <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
            <table className={CARD_TABLE.table}>
              <caption className="sr-only">{t('items.title')}</caption>
              <thead className={CARD_TABLE.head}>
                <tr>
                  <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {t('items.col.order')}
                  </th>
                  <th scope="col" className="whitespace-nowrap px-4 py-3 text-end font-medium">
                    {t('items.col.share')}
                  </th>
                </tr>
              </thead>
              <tbody className={CARD_TABLE.body}>
                {detail.items.map((item) => (
                  <tr key={item.sellerOrderId} className={CARD_TABLE.row}>
                    <td className={CARD_TABLE.cell}>
                      <span title={item.sellerOrderId}>
                        {t('items.order', { id: shortId(item.sellerOrderId) })}
                      </span>
                    </td>
                    <td
                      className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                      data-label={t('items.col.share')}
                    >
                      <span>{money(item.amount)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ApproveDialog
        payoutId={open ? detail.payoutId : null}
        csrfToken={csrfToken}
        zone={zone}
        onClose={() => setOpen(false)}
        onApproved={approved}
        onStale={() => void refresh()}
      />
    </div>
  );
}
