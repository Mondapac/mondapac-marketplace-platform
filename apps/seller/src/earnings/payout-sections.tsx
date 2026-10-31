'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  CARD_TABLE,
  DataList,
  EmptyState,
  LoadError,
  SkeletonRows,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from '../catalog/format.ts';
import { resolveZone } from '../price/zone-time.ts';
import { dateFormat } from '../shared/intl.ts';
import type { OwnDispute } from '../disputes/types.ts';
import { shortId } from '../orders/status.ts';
import { formatMinor } from '../price/money.ts';
import {
  BLOCK_REASONS,
  HELD_REASONS,
  HISTORY_PAGE,
  PAYOUT_STATUSES,
  type NextPayout,
  type OwnHeld,
  type OwnHolds,
  type OwnPayout,
  type OwnPayouts,
  type PayoutMoney,
  type PayoutsInitial,
} from './payout-types.ts';

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  scheduled: 'neutral',
  'awaiting-approval': 'attention',
  'on-its-way': 'info',
  paid: 'success',
  'not-sent': 'neutral',
  failed: 'critical',
  settled: 'neutral',
};

/** Add up minor-unit strings without a float. */
const sum = (values: readonly string[]): bigint =>
  values.reduce((total, value) => total + (/^[0-9]{1,18}$/.test(value) ? BigInt(value) : 0n), 0n);

type Load<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'failed' };

/**
 * The payout part of the seller's earnings page: the next payout (with what is ready, on hold and
 * owed), the money on hold, and the payout history. Each section reads on its own, so one that
 * fails shows a retry and the others still show. Nothing here decides anything: the amount is the
 * API's estimate, and a reason is shown as one sentence.
 */
export function PayoutSections({
  initial,
  currency,
  balance,
  disputes,
  children,
}: {
  readonly initial: PayoutsInitial;
  /** Rendered between the next payout and the money on hold (the ledger totals and disputes). */
  readonly children?: ReactNode;
  readonly currency: string;
  /** The ledger balance in minor units; below zero is what the seller owes. */
  readonly balance: string;
  readonly disputes: readonly OwnDispute[];
}) {
  const t = useTranslations('payouts');
  const tl = useTranslations('load');
  const locale = useLocale();
  const zone = useTimeZone();
  const [next, setNext] = useState<Load<NextPayout> | 'loading'>(
    initial.next === null ? { kind: 'failed' } : { kind: 'ok', value: initial.next },
  );
  const [holds, setHolds] = useState<Load<readonly OwnHeld[]> | 'loading'>(
    initial.holds === null ? { kind: 'failed' } : { kind: 'ok', value: initial.holds },
  );
  const [history, setHistory] = useState<Load<OwnPayouts> | 'loading'>(
    initial.history === null ? { kind: 'failed' } : { kind: 'ok', value: initial.history },
  );
  const [moreFailed, setMoreFailed] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const money = (value: PayoutMoney) => formatMinor(value.amountMinor, value.currency, locale);
  const major = (minor: bigint) => formatMinor(minor.toString(), currency, locale);

  async function reread<T>(
    path: string,
    set: (load: Load<T> | 'loading') => void,
    pick: (body: never) => T,
  ) {
    set('loading');
    const result = await callApi<never>('GET', path);
    if (result.ok) {
      set({ kind: 'ok', value: pick(result.body) });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    set({ kind: 'failed' });
  }

  async function more() {
    if (history === 'loading' || history.kind !== 'ok' || history.value.nextCursor === null) return;
    if (moreLoading) return;
    setMoreLoading(true);
    setMoreFailed(false);
    const result = await callApi<OwnPayouts>(
      'GET',
      `commission-payouts/seller/payouts?limit=${HISTORY_PAGE}&cursor=${encodeURIComponent(history.value.nextCursor)}`,
    );
    setMoreLoading(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setMoreFailed(true);
      return;
    }
    const known = new Set(history.value.payouts.map((payout) => payout.payoutId));
    setHistory({
      kind: 'ok',
      value: {
        payouts: [
          ...history.value.payouts,
          ...result.body.payouts.filter((payout) => !known.has(payout.payoutId)),
        ],
        nextCursor: result.body.nextCursor,
      },
    });
  }

  const owed = BigInt(/^-[0-9]{1,18}$/.test(balance) ? balance.slice(1) : '0');
  const heldList = holds !== 'loading' && holds.kind === 'ok' ? holds.value : null;
  const heldWithAmount = (heldList ?? []).filter((held) => held.amount !== null);
  const heldTotal = sum(heldWithAmount.map((held) => held.amount?.amountMinor ?? '0'));
  const ready =
    next !== 'loading' && next.kind === 'ok' && next.value.estimatedAmount !== null
      ? BigInt(next.value.estimatedAmount.amountMinor)
      : 0n;
  const blocked = next !== 'loading' && next.kind === 'ok' ? next.value.blockReason : null;

  return (
    <>
      <Card title={t('next.title')}>
        {next === 'loading' ? <SkeletonRows label={t('loading')} rows={2} /> : null}
        {next !== 'loading' && next.kind === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3"
            message={t('next.unavailable')}
            retryLabel={tl('retry')}
            onRetry={() =>
              void reread<NextPayout>('commission-payouts/seller/payouts/next', setNext, (b) => b)
            }
          />
        ) : null}
        {next !== 'loading' && next.kind === 'ok' ? (
          <NextBody
            next={next.value}
            locale={locale}
            canOpenAccount={initial.canOpenAccount}
            money={money}
          />
        ) : null}
        {next !== 'loading' && next.kind === 'ok' ? (
          <DataList
            variant="totals"
            missing="-"
            rows={[
              {
                label: t('next.ready'),
                value: blocked === null ? major(ready) : t('next.ready-blocked'),
              },
              {
                label: t('next.on-hold'),
                value:
                  heldList === null
                    ? '-'
                    : t('next.on-hold-value', {
                        amount: major(heldTotal),
                        count: heldWithAmount.length,
                      }),
              },
              {
                label: t('next.you-owe'),
                value: owed === 0n ? major(0n) : t('next.owe-value', { amount: major(owed) }),
              },
            ]}
          />
        ) : null}
        {next !== 'loading' && next.kind === 'ok' ? (
          <p className="text-sm text-fg-muted">{t('next.note')}</p>
        ) : null}
      </Card>

      {children}

      <section aria-labelledby="held-title" className="flex flex-col gap-3">
        <h2 id="held-title" className="text-lg font-semibold">
          {t('held.title')}
        </h2>
        {holds === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
        {holds !== 'loading' && holds.kind === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3"
            message={t('held.unavailable')}
            retryLabel={tl('retry')}
            onRetry={() =>
              void reread<readonly OwnHeld[]>(
                'commission-payouts/seller/payout-holds',
                setHolds,
                (body: OwnHolds) => body.holds,
              )
            }
          />
        ) : null}
        {holds !== 'loading' && holds.kind === 'ok' ? (
          holds.value.length === 0 ? (
            <EmptyState icon="wallet" title={t('held.empty.title')} body={t('held.empty.body')} />
          ) : (
            <HeldTable
              holds={holds.value}
              disputes={disputes}
              zone={initial.next?.zone ?? zone}
              locale={locale}
              money={money}
            />
          )
        ) : null}
      </section>

      <section aria-labelledby="history-title" className="flex flex-col gap-3">
        <h2 id="history-title" className="text-lg font-semibold">
          {t('history.title')}
        </h2>
        {history === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
        {history !== 'loading' && history.kind === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3"
            message={t('history.unavailable')}
            retryLabel={tl('retry')}
            onRetry={() =>
              void reread<OwnPayouts>(
                `commission-payouts/seller/payouts?limit=${HISTORY_PAGE}`,
                setHistory,
                (body: OwnPayouts) => body,
              )
            }
          />
        ) : null}
        {history !== 'loading' && history.kind === 'ok' ? (
          history.value.payouts.length === 0 ? (
            <EmptyState
              icon="receipt"
              title={t('history.empty.title')}
              body={t('history.empty.body')}
            />
          ) : (
            <HistoryTable
              payouts={history.value.payouts}
              zone={initial.next?.zone ?? zone ?? null}
              locale={locale}
              money={money}
            />
          )
        ) : null}
        {moreFailed ? <Banner tone="critical">{t('history.more-failed')}</Banner> : null}
        {history !== 'loading' && history.kind === 'ok' && history.value.nextCursor !== null ? (
          <div>
            <Button variant="secondary" loading={moreLoading} onClick={() => void more()}>
              {t('history.more')}
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}

/** The estimate and when it is looked at, or the reason it is not on its way, in one sentence. */
function NextBody({
  next,
  locale,
  canOpenAccount,
  money,
}: {
  readonly next: NextPayout;
  readonly locale: string;
  readonly canOpenAccount: boolean;
  readonly money: (value: PayoutMoney) => string;
}) {
  const t = useTranslations('payouts.next');
  const reason =
    next.blockReason === null
      ? null
      : (BLOCK_REASONS as readonly string[]).includes(next.blockReason)
        ? next.blockReason
        : 'unknown';
  const slot =
    next.slotAt === null ? null : shortInstant(next.slotAt, locale, next.zone ?? undefined);
  const account =
    canOpenAccount && (reason === 'account-not-ready' || reason === null) ? (
      <a className="font-medium text-link underline" href="/payout-account">
        {t('manage-account')}
      </a>
    ) : null;
  if (reason !== null) {
    return (
      <div className="flex flex-col gap-2">
        <Banner tone={reason === 'below-minimum' ? 'info' : 'attention'}>
          {t(`block.${reason}` as 'block.unknown')}
        </Banner>
        {slot === null ? null : (
          <p className="text-sm text-fg-muted">{t('slot-blocked', { when: slot })}</p>
        )}
        {account}
      </div>
    );
  }
  if (next.estimatedAmount === null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-fg-muted">{t('nothing')}</p>
        {slot === null ? null : (
          <p className="text-sm text-fg-muted">{t('slot', { when: slot })}</p>
        )}
        {account}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-3xl font-semibold tabular-nums">{money(next.estimatedAmount)}</p>
        <Badge tone="info">{t('estimated')}</Badge>
      </div>
      {slot === null ? null : <p>{t('slot', { when: slot })}</p>}
      {account}
    </div>
  );
}

function HeldTable({
  holds,
  disputes,
  zone,
  locale,
  money,
}: {
  readonly holds: readonly OwnHeld[];
  readonly disputes: readonly OwnDispute[];
  readonly zone: string | undefined;
  readonly locale: string;
  readonly money: (value: PayoutMoney) => string;
}) {
  const t = useTranslations('payouts.held');
  const td = useTranslations('disputes');
  const disputed = new Set(disputes.filter((d) => d.open).map((d) => d.sellerOrderId));
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {(['order', 'reason', 'why', 'available', 'share'] as const).map((col) => (
              <th
                key={col}
                scope="col"
                className={`whitespace-nowrap px-4 py-3 font-medium ${col === 'share' ? 'text-end' : ''}`}
              >
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {holds.map((held, index) => {
            const isDisputed = held.sellerOrderId !== null && disputed.has(held.sellerOrderId);
            const reason = (HELD_REASONS as readonly string[]).includes(held.reason)
              ? held.reason
              : 'on-hold';
            return (
              <tr key={`${held.sellerOrderId ?? 'whole'}-${index}`} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  {held.sellerOrderId === null ? (
                    <span>{t('whole-store')}</span>
                  ) : (
                    <a
                      className="font-medium text-link underline"
                      href={`/orders/${held.sellerOrderId}`}
                      title={held.sellerOrderId}
                    >
                      {t('order', { id: shortId(held.sellerOrderId) })}
                    </a>
                  )}
                </td>
                <td className={CARD_TABLE.corner}>
                  <Badge tone={isDisputed ? 'critical' : 'neutral'}>
                    {isDisputed ? td('badge') : t(`reason.${reason}` as 'reason.on-hold')}
                  </Badge>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.why')}>
                  <span>
                    {isDisputed ? td('held') : t(`explain.${reason}` as 'explain.on-hold')}
                  </span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.available')}>
                  <span>
                    {held.availableFrom === null
                      ? isDisputed || reason === 'refund-pending' || reason === 'on-hold'
                        ? '-'
                        : t('after-delivery')
                      : shortDay(held.availableFrom, locale, zone)}
                  </span>
                </td>
                <td
                  className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                  data-label={t('col.share')}
                >
                  <span>{held.amount === null ? '-' : money(held.amount)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A day without the time ("Fri 30 Oct"), in the store's zone. */
function shortDay(iso: string, locale: string, zone: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return dateFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: resolveZone(zone),
  }).format(date);
}

function HistoryTable({
  payouts,
  zone,
  locale,
  money,
}: {
  readonly payouts: readonly OwnPayout[];
  readonly zone: string | null;
  readonly locale: string;
  readonly money: (value: PayoutMoney) => string;
}) {
  const t = useTranslations('payouts.history');
  const tn = useTranslations('payouts.next');
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {(['date', 'status', 'note', 'amount'] as const).map((col) => (
              <th
                key={col}
                scope="col"
                className={`whitespace-nowrap px-4 py-3 font-medium ${col === 'amount' ? 'text-end' : ''}`}
              >
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {payouts.map((payout) => {
            const status = (PAYOUT_STATUSES as readonly string[]).includes(payout.status)
              ? payout.status
              : 'unknown';
            const reasonKey =
              payout.reason !== null && (BLOCK_REASONS as readonly string[]).includes(payout.reason)
                ? payout.reason
                : null;
            const keptNote =
              BigInt(payout.netted.amountMinor) > 0n && status !== 'settled'
                ? t('kept', { amount: money(payout.netted) })
                : null;
            return (
              <tr key={payout.payoutId} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  {shortInstant(payout.slotAt, locale, zone ?? undefined)}
                </td>
                <td className={CARD_TABLE.corner}>
                  <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
                    {t(`status.${status}` as 'status.paid')}
                  </Badge>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.note')}>
                  <span>
                    {status === 'failed'
                      ? t('failed-note')
                      : status === 'not-sent'
                        ? reasonKey === null
                          ? t('not-sent-note')
                          : tn(`block-short.${reasonKey}` as 'block-short.below-minimum')
                        : status === 'settled'
                          ? t('settled-note', { amount: money(payout.netted) })
                          : status === 'awaiting-approval'
                            ? t('first-note')
                            : '-'}
                  </span>
                </td>
                <td
                  className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                  data-label={t('col.amount')}
                >
                  <span className="flex flex-col lg:items-end">
                    <span>{money(payout.transfer)}</span>
                    {keptNote === null ? null : (
                      <span className="text-xs font-normal text-fg-muted">{keptNote}</span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
