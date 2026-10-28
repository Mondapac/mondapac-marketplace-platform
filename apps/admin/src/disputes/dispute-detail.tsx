'use client';

import {
  BackLink,
  Badge,
  Banner,
  Button,
  Card,
  DataList,
  type BadgeTone,
  type DataListRow,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { known } from '../sellers/format.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { formatMinor } from '../wallet/money.ts';
import { DecisionDialog, type DecisionTarget } from './decision-dialog.tsx';
import { EvidenceDueText } from './evidence-due.tsx';
import { reasonText } from './evidence.ts';
import { MoneyStateBadge } from './money-state-badge.tsx';
import {
  BUCKETS,
  REASON_CODES,
  STRIPE_DASHBOARD_DISPUTES,
  type DisputeDetail,
  type DisputeMoney,
  type DisputeSellerOrder,
} from './types.ts';

const BUCKET_TONE: Readonly<Record<string, BadgeTone>> = {
  'needs-response': 'attention',
  'decision-needed': 'critical',
  'under-review': 'neutral',
  won: 'success',
  closed: 'neutral',
};
const TIMELINE_KINDS = [
  'opened',
  'funds-withdrawn',
  'funds-reinstated',
  'closed',
  'decided',
  'decision-reversed',
];

/**
 * One dispute case: the summary, a part for each seller order (where a decision is recorded) and
 * the timeline. The case is read by the page server; a saved decision reads it again from the
 * relay, and nothing on screen is guessed.
 */
export function DisputeDetailView({
  initial,
  zone,
  canDecide,
  accountId,
  csrfToken,
}: {
  readonly initial: DisputeDetail;
  readonly zone: string;
  /** The session holds commission-payouts.dispute.attribute (the API decides again). */
  readonly canDecide: boolean;
  readonly accountId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('disputes');
  const locale = useLocale();
  const [detail, setDetail] = useState(initial);
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  const [notice, setNotice] = useState<'saved' | 'stale' | null>(null);
  const [now] = useState(() => Date.now());
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  const money = (value: DisputeMoney) => formatMinor(value.amountMinor, value.currency, locale);
  const when = (iso: string) => shortInstantInZone(iso, locale, zone);
  const who = (id: string) =>
    id === accountId ? t('you') : t('another-admin', { id: shortId(id) });
  const reasonLabel = (code: string) =>
    (REASON_CODES as readonly string[]).includes(code) ? t(`decision.reason.${code}`) : code;
  const storeOf = (order: { storeName: string | null; sellerId: string }) =>
    order.storeName ?? t('unnamed', { id: shortId(order.sellerId) });

  async function refresh(): Promise<boolean> {
    const result = await callApi<DisputeDetail>(
      'GET',
      `commission-payouts/admin/disputes/${encodeURIComponent(detail.disputeId)}`,
    );
    if (result.ok) {
      setDetail(result.body);
      return true;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    return false;
  }

  const summary: DataListRow[] = [
    { label: t('summary.amount'), value: money(detail.amount) },
    {
      label: t('summary.money'),
      value: detail.moneyState === 'none' ? null : <MoneyStateBadge state={detail.moneyState} />,
    },
    {
      label: t('summary.evidence'),
      value: (
        <EvidenceDueText iso={detail.closed ? null : detail.evidenceDueBy} zone={zone} now={now} />
      ),
    },
    { label: t('summary.reason'), value: reasonText(detail.reason) },
    {
      label: t('summary.order'),
      value: <span title={detail.orderId}>{shortId(detail.orderId)}</span>,
    },
    { label: t('summary.opened'), value: when(detail.openedAt) },
    {
      label: t('summary.stripe'),
      value: (
        <a
          className="font-medium text-link underline"
          href={`${STRIPE_DASHBOARD_DISPUTES}${encodeURIComponent(detail.providerDisputeId)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('stripe.open')}
          <span className="sr-only"> {t('stripe.new-tab')}</span>
        </a>
      ),
    },
  ];

  function decidedRows(order: DisputeSellerOrder): DataListRow[] {
    const decided = order.decided;
    if (decided === null) return [];
    const rows: DataListRow[] = [
      { label: t('part.decided-by'), value: who(decided.decidedBy) },
      { label: t('part.decided-at'), value: when(decided.decidedAt) },
      {
        label: t('part.option'),
        value: decided.bearer === 'seller' ? t('part.option-seller') : t('part.option-platform'),
      },
      { label: t('part.reason'), value: reasonLabel(decided.reasonCode) },
      {
        label: t('part.amount'),
        value: decided.amount === null ? t('part.amount-none') : money(decided.amount),
      },
    ];
    if (decided.reversal !== null) {
      rows.push(
        {
          label: t('part.returned'),
          value: t('part.returned-value', {
            who: who(decided.reversal.decidedBy),
            when: when(decided.reversal.decidedAt),
          }),
        },
        { label: t('part.returned-reason'), value: reasonLabel(decided.reversal.reasonCode) },
      );
    }
    return rows;
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink href="/disputes" label={t('title')} />
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-words text-2xl font-semibold">
          {t('detail.title', { id: shortId(detail.orderId) })}
        </h1>
        <Badge tone={BUCKET_TONE[detail.bucket] ?? 'neutral'}>
          {t(`filter.${known(detail.bucket, BUCKETS)}` as 'filter.closed')}
        </Badge>
      </div>
      {detail.needsReview ? (
        <Banner tone="attention">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="attention">{t('review.badge')}</Badge>
            <span>{t('review.body')}</span>
          </p>
        </Banner>
      ) : null}
      {notice === null ? null : (
        <div ref={noticeRef} tabIndex={-1}>
          <Banner tone={notice === 'saved' ? 'success' : 'attention'}>
            {t(notice === 'saved' ? 'decision.saved' : 'decision.saved-stale')}
          </Banner>
        </div>
      )}
      <Card title={t('summary.title')}>
        <DataList missing="-" rows={summary} />
        <p className="text-sm text-fg-muted">{t('zone-note', { zone })}</p>
      </Card>
      <Card title={t('part.title')}>
        <p className="text-sm text-fg-muted">{t('footnote')}</p>
        <ul className="flex flex-col gap-4">
          {detail.sellerOrders.map((order) => {
            const canAct =
              canDecide && (order.decision === 'allowed' || order.decision === 'reversal-allowed');
            return (
              <li
                key={order.sellerOrderId}
                className="flex flex-col gap-3 rounded-md border border-line p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold text-fg">{storeOf(order)}</h3>
                    <p className="text-sm text-fg-muted">
                      {t('part.order', { id: shortId(order.sellerOrderId) })}
                    </p>
                  </div>
                  <Badge tone={order.holdActive ? 'attention' : 'neutral'}>
                    {t(order.holdActive ? 'part.held' : 'part.not-held')}
                  </Badge>
                </div>
                <DataList
                  missing="-"
                  rows={[
                    { label: t('part.share'), value: money(order.sellerShare) },
                    { label: t('part.cap'), value: money(order.recoverableCap) },
                    ...decidedRows(order),
                  ]}
                />
                {canAct ? (
                  <div>
                    <Button
                      variant={order.decision === 'allowed' ? 'primary' : 'secondary'}
                      onClick={() => {
                        setNotice(null);
                        setTarget({
                          disputeId: detail.disputeId,
                          sellerOrder: order,
                          mode: order.decision === 'allowed' ? 'decide' : 'reverse',
                        });
                      }}
                    >
                      {t(order.decision === 'allowed' ? 'part.decide' : 'part.return')}
                    </Button>
                  </div>
                ) : order.decided === null ? (
                  <p className="text-sm text-fg-muted">{t('part.not-yet')}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title={t('timeline.title')}>
        <ol className="flex flex-col gap-3">
          {detail.timeline.map((entry, index) => {
            const order = detail.sellerOrders.find((o) => o.sellerOrderId === entry.sellerOrderId);
            const kind = TIMELINE_KINDS.includes(entry.kind) ? entry.kind : 'unknown';
            return (
              <li
                key={`${entry.kind}-${entry.at}-${index}`}
                className="flex flex-col gap-0.5 sm:flex-row sm:gap-4"
              >
                <time dateTime={entry.at} className="text-sm text-fg-muted sm:w-40 sm:shrink-0">
                  {when(entry.at)}
                </time>
                <span className="text-fg">
                  {t(`timeline.kind.${kind}` as 'timeline.kind.opened')}
                  {order === undefined ? '' : ` · ${storeOf(order)}`}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>
      <DecisionDialog
        target={target}
        csrfToken={csrfToken}
        onClose={() => setTarget(null)}
        onSaved={() => {
          setTarget(null);
          void refresh().then((ok) => setNotice(ok ? 'saved' : 'stale'));
        }}
        onStale={() => void refresh()}
      />
    </div>
  );
}
