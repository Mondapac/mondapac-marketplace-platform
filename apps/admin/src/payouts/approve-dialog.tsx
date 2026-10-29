'use client';

import { Badge, Banner, Button, DataList, Dialog, LoadError, SkeletonRows } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { formatMinor } from '../wallet/money.ts';
import { approveProblemOf, STALE_PROBLEMS } from './errors.ts';
import { bankWaitUntil, type Approved, type PayoutDetail } from './types.ts';

type Load = { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'ok' };

/**
 * Approves one payout that waits for an admin. The payout is read when the dialog opens, so the
 * admin approves what is on screen: the primary button carries the exact transfer amount and the
 * same amount is echoed to the server, which refuses a different one. No code is asked for here:
 * the guarded call opens the shared step-up dialog, and a cancelled code leaves this one as it
 * was. Focus starts on Cancel. When the payout cannot be approved (bank-change waiting period,
 * account not ready, no longer waiting) the reason is shown and there is no approve button.
 */
export function ApproveDialog({
  payoutId,
  csrfToken,
  zone,
  onClose,
  onApproved,
  onStale,
}: {
  readonly payoutId: string | null;
  readonly csrfToken: string;
  readonly zone: string;
  readonly onClose: () => void;
  readonly onApproved: (approved: Approved) => void;
  /** The payout changed under the admin: the screen behind reads its data again. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('payouts.approve');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [detail, setDetail] = useState<PayoutDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const ticket = useRef(0);

  const read = useCallback(async (id: string) => {
    const mine = ++ticket.current;
    setLoad({ kind: 'loading' });
    const result = await callApi<PayoutDetail>(
      'GET',
      `commission-payouts/admin/payouts/${encodeURIComponent(id)}`,
    );
    if (mine !== ticket.current) return;
    if (result.ok) {
      setDetail(result.body);
      setLoad({ kind: 'ok' });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ kind: 'failed' });
  }, []);

  // Every opening starts clean and reads the payout again.
  useEffect(() => {
    if (payoutId === null) return;
    setDetail(null);
    setProblem(null);
    setPending(false);
    void read(payoutId);
  }, [payoutId, read]);

  const money = (value: { amountMinor: string; currency: string }) =>
    formatMinor(value.amountMinor, value.currency, locale);
  const when = (iso: string) => shortInstantInZone(iso, locale, zone);

  const waitUntil = detail === null ? null : bankWaitUntil(detail, Date.now());
  const waiting = detail !== null && detail.state === 'awaiting-approval';
  const notReady = detail?.accountReadiness === 'not-ready';
  const aboveLimit = detail?.limits?.transferAboveLimit === true;
  const stopped = problem !== null && STALE_PROBLEMS.includes(problem);
  const canApprove =
    detail !== null && waiting && waitUntil === null && !notReady && !aboveLimit && !stopped;

  async function approve() {
    if (detail === null || busy.current || !canApprove) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await guarded<Approved>(
      'POST',
      `commission-payouts/admin/payouts/${encodeURIComponent(detail.payoutId)}/approve`,
      { amountMinor: detail.transfer.amountMinor },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onApproved(result.body);
      return;
    }
    // A cancelled code leaves the dialog exactly as it was.
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = approveProblemOf(result.failure);
    setProblem(key);
    if (STALE_PROBLEMS.includes(key)) onStale();
  }

  const rows =
    detail === null
      ? []
      : [
          { label: t('seller'), value: detail.storeName ?? t('unnamed') },
          {
            label: t('why'),
            value: detail.approvalReason === null ? null : t(`why-${detail.approvalReason}`),
          },
          {
            label: t('account'),
            value: t(`account-${detail.accountReadiness}`),
          },
          {
            label: t('bank-changed'),
            value:
              detail.lastBankChangeAt === null
                ? t('bank-changed-none')
                : when(detail.lastBankChangeAt),
          },
          { label: t('gross'), value: money(detail.gross) },
          { label: t('netted'), value: money(detail.netted) },
          { label: t('transfer'), value: money(detail.transfer) },
          ...(detail.limits === null
            ? []
            : [
                { label: t('limit'), value: money(detail.limits.perTransfer) },
                {
                  label: t('today'),
                  value: t('today-value', {
                    total: money(detail.limits.todayTotal),
                    level: money(detail.limits.dailyAlertLevel),
                  }),
                },
              ]),
        ];

  return (
    <Dialog
      open={payoutId !== null}
      title={t('title')}
      onClose={() => {
        if (!busy.current) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" autoFocus onClick={onClose} disabled={pending}>
            {stopped || (detail !== null && !canApprove) ? t('close') : t('cancel')}
          </Button>
          {canApprove && detail !== null ? (
            <Button loading={pending} onClick={() => void approve()}>
              {t('action', { amount: money(detail.transfer) })}
            </Button>
          ) : null}
        </>
      }
    >
      {load.kind === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
      {load.kind === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('load-failed')}
          retryLabel={t('retry')}
          onRetry={() => payoutId !== null && void read(payoutId)}
        />
      ) : null}
      {load.kind === 'ok' && detail !== null ? (
        <div className="flex flex-col gap-4">
          <p>{t('intro')}</p>
          {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
          {!waiting && problem === null ? (
            <Banner tone="attention">{t('error.not-awaiting')}</Banner>
          ) : null}
          {waiting && waitUntil !== null ? (
            <Banner tone="attention">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone="attention">{t('bank-wait', { until: when(waitUntil) })}</Badge>
                <span>{t('bank-wait-body')}</span>
              </p>
            </Banner>
          ) : null}
          {waiting && notReady ? <Banner tone="attention">{t('not-ready')}</Banner> : null}
          {waiting && aboveLimit && detail.limits !== null ? (
            <Banner tone="attention">
              {t('above-limit', { limit: money(detail.limits.perTransfer) })}
            </Banner>
          ) : null}
          {waiting && detail.limits?.overDailyAlertLevel === true ? (
            <Banner tone="attention">{t('over-level')}</Banner>
          ) : null}
          <DataList missing="-" rows={rows} />
          <p className="text-sm text-fg-muted">{t('zone-note', { zone })}</p>
        </div>
      ) : null}
    </Dialog>
  );
}
