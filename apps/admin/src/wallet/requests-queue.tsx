'use client';

import {
  Badge,
  Banner,
  Button,
  CARD_TABLE,
  Dialog,
  EmptyState,
  LoadError,
  Select,
  SkeletonRows,
  toast,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { walletProblemOf } from './errors.ts';
import { wordFor } from './labels.ts';
import { formatMinor } from './money.ts';
import {
  PAGE_SIZE,
  REJECT_REASONS,
  type AdminCredit,
  type CreditList,
  type CreditStatus,
  type QueueTab,
} from './types.ts';

const STATUS_TONE: Readonly<Record<CreditStatus, BadgeTone>> = {
  granted: 'success',
  pending: 'attention',
  approved: 'success',
  rejected: 'critical',
  expired: 'neutral',
};

type Step = { readonly kind: 'approve' | 'reject'; readonly row: AdminCredit } | null;

/**
 * The credit requests of the Market for one tab. Approve and reject go through the step-up dialog;
 * the admin who asked cannot decide their own request (the buttons are off, with the reason in
 * text, and the API refuses it as well). The response drives the row; nothing is optimistic.
 */
export function RequestsQueue({
  tab,
  canApprove,
  accountId,
  csrfToken,
}: {
  readonly tab: QueueTab;
  readonly canApprove: boolean;
  readonly accountId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('wallet');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [rows, setRows] = useState<readonly AdminCredit[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [step, setStep] = useState<Step>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  // After a decision its buttons are gone and the toast takes no focus: focus goes to the decided
  // row, or to the list when the row left it (the Pending tab shows only waiting requests).
  const decidedId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  useEffect(() => {
    const id = decidedId.current;
    if (id === null) return;
    decidedId.current = null;
    (rowRefs.current.get(id) ?? listRef.current)?.focus();
  });

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query = new URLSearchParams({ status: tab, limit: String(PAGE_SIZE) });
      if (cursor !== null) query.set('cursor', cursor);
      return callApi<CreditList>('GET', `wallet/admin/credit-requests?${query.toString()}`);
    },
    [tab],
  );

  const load = useCallback(async () => {
    setLoadFailed(false);
    const result = await fetchPage(null);
    if (result.ok) {
      // A status the panel does not know is not shown as a guess.
      if (result.body.entries.some((entry) => !(entry.status in STATUS_TONE))) {
        setLoadFailed(true);
        return;
      }
      setRows(result.body.entries);
      setNext(result.body.nextCursor);
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setLoadFailed(true);
  }, [fetchPage]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  async function loadMore() {
    if (loadingMore || next === null) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await fetchPage(next);
    setLoadingMore(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setMoreFailed(true);
      return;
    }
    setRows((current) => [...(current ?? []), ...result.body.entries]);
    setNext(result.body.nextCursor);
    setAnnounce(t('queue.loaded-more', { count: result.body.entries.length }));
  }

  function replace(updated: AdminCredit) {
    setRows((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)));
  }
  const drop = (id: string) => setRows((current) => (current ?? []).filter((row) => row.id !== id));

  async function decide(kind: 'approve' | 'reject', row: AdminCredit) {
    if (busy.current) return;
    if (kind === 'reject' && reason === '') {
      setReasonError(true);
      return;
    }
    busy.current = true;
    setPending(true);
    // The confirm closes; the code dialog opens on its own (no stack of two dialogs).
    setStep(null);
    setNotice(null);
    const result = await guarded<AdminCredit>(
      'POST',
      `wallet/admin/credit-requests/${encodeURIComponent(row.id)}/${kind}`,
      kind === 'reject' ? { reasonCode: reason } : undefined,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      replace(result.body);
      decidedId.current = row.id;
      setReason('');
      toast.success(
        kind === 'approve'
          ? t('queue.notice.approved', { amount: formatMinor(row.amount, row.currency, locale) })
          : t('queue.notice.rejected'),
      );
      return;
    }
    if (isStepUpCancelled(result)) return;
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = walletProblemOf(failure, 'decide');
    // An expired request is marked Expired (it shows on the other tabs) and leaves Pending; a
    // decided or vanished one leaves the list. The banner says why in both cases.
    if (key === 'request-expired') replace({ ...row, status: 'expired' });
    else if (key === 'request-decided' || key === 'request-not-found') drop(row.id);
    setNotice(t(`error.${key}`));
  }

  if (loadFailed) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('load-failed')}
        retryLabel={t('retry')}
        onRetry={() => void load()}
      />
    );
  }
  if (rows === null) return <SkeletonRows label={t('loading')} rows={4} />;

  // Pending shows only requests still waiting; a decided one has left the tab.
  const visible = tab === 'pending' ? rows.filter((row) => row.status === 'pending') : rows;
  const label = (group: string, code: string | null) => wordFor(t, group, code);

  return (
    <div ref={listRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      {notice === null ? null : (
        <div ref={noticeRef} tabIndex={-1}>
          <Banner tone="critical">{notice}</Banner>
        </div>
      )}
      {visible.length === 0 ? (
        <EmptyState icon="inbox" title={t(`queue.empty.${tab}`)} />
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t(`queue.caption.${tab}`)}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                {[
                  'customer',
                  'amount',
                  'reason',
                  'status',
                  'requested-by',
                  'requested',
                  'until',
                  'actions',
                ].map((col) => (
                  <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(`queue.col.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {visible.flatMap((row) => {
                const own = row.requestedBy === accountId;
                const hintId = `own-${row.id}`;
                const expanded = open.has(row.id);
                const lines = [
                  <tr
                    key={row.id}
                    ref={(element) => {
                      if (element === null) rowRefs.current.delete(row.id);
                      else rowRefs.current.set(row.id, element);
                    }}
                    tabIndex={-1}
                    className={`${CARD_TABLE.row} outline-none`}
                  >
                    <td className={`${CARD_TABLE.cell} min-w-0`}>
                      <a
                        className="font-semibold text-link underline"
                        href={`/wallet/credits?customer=${encodeURIComponent(row.customerAccountId)}`}
                        title={row.customerAccountId}
                      >
                        {shortId(row.customerAccountId)}
                      </a>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('queue.col.amount')}>
                      <span className="font-medium">
                        {formatMinor(row.amount, row.currency, locale)}
                      </span>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('queue.col.reason')}>
                      <span>{label('credit.reason', row.reasonCode)}</span>
                    </td>
                    <td className={CARD_TABLE.corner}>
                      <Badge tone={STATUS_TONE[row.status]}>
                        {t(`queue.status.${row.status}`)}
                      </Badge>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('queue.col.requested-by')}>
                      <span title={row.requestedBy}>
                        {own ? t('queue.you') : shortId(row.requestedBy)}
                      </span>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('queue.col.requested')}>
                      <span>{shortInstant(row.requestedAt, locale)}</span>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('queue.col.until')}>
                      <span>
                        {shortInstant(
                          row.status === 'pending' ? row.expiresAt : row.decidedAt,
                          locale,
                        )}
                      </span>
                    </td>
                    <td className={`${CARD_TABLE.labelled} max-lg:!block`} data-label="">
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          {canApprove && row.status === 'pending' ? (
                            <>
                              <Button
                                disabled={own || pending}
                                aria-describedby={own ? hintId : undefined}
                                onClick={() => setStep({ kind: 'approve', row })}
                              >
                                {t('queue.approve')}
                              </Button>
                              <Button
                                variant="secondary"
                                disabled={own || pending}
                                aria-describedby={own ? hintId : undefined}
                                onClick={() => {
                                  setReason('');
                                  setReasonError(false);
                                  setStep({ kind: 'reject', row });
                                }}
                              >
                                {t('queue.reject')}
                              </Button>
                            </>
                          ) : null}
                          <Button
                            variant="link"
                            aria-expanded={expanded}
                            onClick={() =>
                              setOpen((current) => {
                                const copy = new Set(current);
                                if (!copy.delete(row.id)) copy.add(row.id);
                                return copy;
                              })
                            }
                          >
                            {t('queue.details')}
                          </Button>
                        </div>
                        {canApprove && row.status === 'pending' && own ? (
                          <p id={hintId} className="text-sm text-fg-muted">
                            {t('error.approver-is-requester')}
                          </p>
                        ) : null}
                      </div>
                    </td>
                  </tr>,
                ];
                if (expanded) {
                  lines.push(
                    <tr key={`${row.id}-details`} className="bg-subtle">
                      <td colSpan={8} className="px-4 py-3">
                        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                          <dt className="text-fg-muted">{t('queue.detail.note')}</dt>
                          <dd className="whitespace-pre-line wrap-anywhere">
                            {row.note ?? t('queue.detail.none')}
                          </dd>
                          <dt className="text-fg-muted">{t('queue.detail.approval-reason')}</dt>
                          <dd>
                            {row.approvalReason === null
                              ? t('queue.detail.none')
                              : label('result.approval-reason', row.approvalReason)}
                          </dd>
                          <dt className="text-fg-muted">{t('queue.detail.decision-reason')}</dt>
                          <dd>
                            {row.decisionReason === null
                              ? t('queue.detail.none')
                              : label('queue.reject-reason', row.decisionReason)}
                          </dd>
                          <dt className="text-fg-muted">{t('queue.detail.decided-by')}</dt>
                          <dd>
                            {row.decidedBy === null
                              ? t('queue.detail.none')
                              : row.decidedBy === accountId
                                ? t('queue.you')
                                : shortId(row.decidedBy)}
                          </dd>
                          <dt className="text-fg-muted">{t('queue.detail.journal')}</dt>
                          <dd>
                            {row.journalId === null
                              ? t('queue.detail.none')
                              : shortId(row.journalId)}
                          </dd>
                        </dl>
                      </td>
                    </tr>,
                  );
                }
                return lines;
              })}
            </tbody>
          </table>
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {moreFailed ? <Banner tone="critical">{t('queue.load-more-failed')}</Banner> : null}
      {next === null ? null : (
        <div>
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            {t('queue.load-more')}
          </Button>
        </div>
      )}
      <Dialog
        open={step?.kind === 'approve'}
        title={t('queue.approve-dialog.title')}
        onClose={() => setStep(null)}
        actions={
          <>
            <Button variant="secondary" autoFocus onClick={() => setStep(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (step !== null) void decide('approve', step.row);
              }}
            >
              {t('queue.approve')}
            </Button>
          </>
        }
      >
        {step?.kind === 'approve' ? (
          <p>
            {t('queue.approve-dialog.body', {
              amount: formatMinor(step.row.amount, step.row.currency, locale),
              customer: shortId(step.row.customerAccountId),
            })}
          </p>
        ) : null}
      </Dialog>
      {/* No autoFocus here: the Reason select is the first control, so the browser focuses it. */}
      <Dialog
        open={step?.kind === 'reject'}
        title={t('queue.reject-dialog.title')}
        onClose={() => setStep(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setStep(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (step !== null) void decide('reject', step.row);
              }}
            >
              {t('queue.reject-dialog.action')}
            </Button>
          </>
        }
      >
        <Select
          label={t('queue.reject-dialog.reason')}
          name="reasonCode"
          placeholder={t('queue.reject-dialog.reason-placeholder')}
          value={reason}
          options={REJECT_REASONS.map((code) => ({
            value: code,
            label: t(`queue.reject-reason.${code}`),
          }))}
          error={reasonError ? t('error.validation-decide') : undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(false);
          }}
        />
      </Dialog>
    </div>
  );
}
