'use client';

import { Banner, Button, Dialog, LoadError, Select, SkeletonRows } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { labelOr } from './label.ts';
import { formatInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { Stars } from './stars.tsx';
import { StatusBadge } from './status-badge.tsx';
import { REASONS, type Action, type ReviewDetail } from './types.ts';

const KNOWN_ACTIONS = new Set<string>(Object.keys(REASONS));

/**
 * One review for a moderator: the content as written, the open report reasons, the signals and
 * the history, then the actions that apply now, each with a reason from a closed list. The two-step
 * code is not asked for here: the change goes through the guarded call, so the shared step-up
 * dialog asks for it, and a cancelled code leaves this dialog as it was. The author is never named.
 * A review is hidden or removed for a reason in the policy, never for being negative.
 */
export function ReviewDialog({
  reviewId,
  canModerate,
  canRemove,
  csrfToken,
  onClose,
  onChanged,
}: {
  readonly reviewId: string | null;
  readonly canModerate: boolean;
  readonly canRemove: boolean;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The review changed (or was found changed): the queue reads again. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('reviews-moderation');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'not-found'>('loading');
  const [action, setAction] = useState<Action | ''>('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const load = useCallback(async (id: string) => {
    setState('loading');
    const result = await callApi<ReviewDetail>(
      'GET',
      `reviews/admin/moderation/${encodeURIComponent(id)}`,
    );
    if (result.ok) {
      setDetail(result.body);
      setState('ready');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setState(result.failure.status === 404 ? 'not-found' : 'failed');
  }, []);

  // Every opening starts clean.
  useEffect(() => {
    if (reviewId === null) return;
    setDetail(null);
    setAction('');
    setReason('');
    setProblem(null);
    void load(reviewId);
  }, [reviewId, load]);

  const allowed = (detail?.allowedActions ?? []).filter(
    (name): name is Action =>
      KNOWN_ACTIONS.has(name) && (name === 'remove' ? canRemove : canModerate),
  );

  async function apply() {
    if (detail === null || action === '' || reason === '' || busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await guarded<ReviewDetail>(
      'POST',
      `reviews/admin/moderation/${encodeURIComponent(detail.id)}/${action}`,
      { reasonCode: reason },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setDetail(result.body);
      setAction('');
      setReason('');
      onChanged();
      return;
    }
    // A cancelled code leaves the dialog and what was chosen exactly as they were.
    if (isStepUpCancelled(result)) return;
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (failure.code === 'reviews.not-moderatable') {
      // Another moderator moved it first: show what it is now.
      setProblem('not-moderatable');
      setAction('');
      setReason('');
      void load(detail.id);
      onChanged();
      return;
    }
    setProblem(failure.status === 404 ? 'not-found' : 'unknown');
  }

  const reasons = action === '' ? [] : REASONS[action];

  return (
    <Dialog
      open={reviewId !== null}
      title={t('dialog.title')}
      onClose={() => {
        if (!busy.current) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('dialog.close')}
          </Button>
          {allowed.length === 0 ? null : (
            <Button
              disabled={action === '' || reason === ''}
              loading={pending}
              onClick={() => void apply()}
            >
              {action === '' ? t('dialog.apply') : t(`action.${action}`)}
            </Button>
          )}
        </>
      }
    >
      {state === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
      {state === 'failed' ? (
        <LoadError
          message={t('error.unavailable')}
          retryLabel={t('retry')}
          onRetry={() => reviewId !== null && void load(reviewId)}
        />
      ) : null}
      {state === 'not-found' ? <p>{t('error.not-found')}</p> : null}
      {state === 'ready' && detail !== null ? (
        <div className="flex flex-col gap-4">
          {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
          <div className="flex flex-wrap items-center gap-3">
            <Stars rating={detail.rating} />
            <StatusBadge status={detail.status} />
            <span className="text-sm text-fg-muted">
              {t('submitted', { date: formatInstant(detail.createdAt, locale) })}
            </span>
          </div>
          <div className="rounded-lg border border-line bg-muted p-4">
            {detail.title === null ? null : (
              <p className="break-words font-medium">{detail.title}</p>
            )}
            {detail.body === null ? (
              <p className="text-fg-muted">{t('no-text')}</p>
            ) : (
              <p className="whitespace-pre-wrap break-words">{detail.body}</p>
            )}
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-fg-muted">{t('product')}</dt>
            <dd className="break-all">
              <a
                className="text-link underline"
                href={`/catalog/products/${encodeURIComponent(detail.productId)}`}
              >
                {shortId(detail.productId)}
              </a>
            </dd>
            <dt className="text-fg-muted">{t('seller')}</dt>
            <dd>{shortId(detail.sellerId)}</dd>
            <dt className="text-fg-muted">{t('signals')}</dt>
            <dd>
              {detail.signalCodes.length === 0
                ? t('none')
                : detail.signalCodes.map((code) => labelOr(t, `signal.${code}`, code)).join(', ')}
            </dd>
            <dt className="text-fg-muted">{t('reports')}</dt>
            <dd>
              {detail.reportReasons.length === 0
                ? t('none')
                : detail.reportReasons
                    .map(
                      (r) =>
                        `${labelOr(t, `report-reason.${r.reasonCode}`, r.reasonCode)} (${r.count})`,
                    )
                    .join(', ')}
            </dd>
          </dl>
          <section aria-labelledby="review-history">
            <h3 id="review-history" className="mb-1 text-sm font-medium">
              {t('history')}
            </h3>
            <ul className="flex flex-col gap-1 text-sm">
              {detail.history.map((h, index) => (
                <li key={`${h.at}-${index}`}>
                  {t('history-line', {
                    date: formatInstant(h.at, locale),
                    who: t(h.byModerator ? 'who.moderator' : 'who.system-or-author'),
                    action: labelOr(t, `history-action.${h.action}`, h.action),
                    reason: labelOr(t, `reason.${h.reasonCode}`, h.reasonCode),
                  })}
                </li>
              ))}
            </ul>
          </section>
          {allowed.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('no-actions')}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg-muted">{t('policy-note')}</p>
              <Select
                label={t('dialog.action')}
                name="action"
                value={action}
                disabled={pending}
                options={[
                  { value: '', label: t('dialog.action-placeholder'), disabled: true },
                  ...allowed.map((name) => ({ value: name, label: t(`action.${name}`) })),
                ]}
                onChange={(event) => {
                  setAction(event.target.value as Action | '');
                  setReason('');
                }}
              />
              {action === '' ? null : (
                <Select
                  label={t('dialog.reason')}
                  name="reasonCode"
                  value={reason}
                  disabled={pending}
                  help={action === 'remove' ? t('dialog.remove-note') : undefined}
                  options={[
                    { value: '', label: t('dialog.reason-placeholder'), disabled: true },
                    ...reasons.map((code) => ({ value: code, label: t(`reason.${code}`) })),
                  ]}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
