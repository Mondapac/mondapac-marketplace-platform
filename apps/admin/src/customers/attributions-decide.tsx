'use client';

import { Button, ConfirmAction, Dialog, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { minutesOf } from './security-shared.tsx';
import {
  DECIDE_MAX,
  attributionSelectorOf,
  type AttributionQuery,
  type DecisionAnswer,
  type DecisionOutcome,
} from './attributions-types.ts';

export type Decision = 'reject' | 'restore';

/** What a decision acts on: the accounts ticked or named, or every account the list matches. */
export type DecideTarget =
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  | { readonly kind: 'matching'; readonly total: number };

export interface DecideRequest {
  readonly decision: Decision;
  readonly target: DecideTarget;
}

const OUTCOMES: readonly DecisionOutcome[] = ['changed', 'unchanged', 'not-found', 'seller-team'];
const LISTED_MAX = 20;

interface Summary {
  readonly decision: Decision;
  readonly counts: Readonly<Record<DecisionOutcome, number>>;
  /** Accounts the decision did not change, with the answer for each. */
  readonly unchanged: readonly { readonly accountId: string; readonly outcome: DecisionOutcome }[];
  /** Accounts never sent because a later request failed (null when every request went through). */
  readonly notSent: number | null;
}

/**
 * Reject or restore seller attributions, for one row or many (customers phase 4a). Each is a
 * level-2 confirmation. A decision takes at most 100 accounts, so a larger selection (after
 * "select all matching", at most 10,000) goes in sequential requests of 100; the answer of every
 * account is then shown in a result dialog with counts, so a partial result is never silent. A
 * concurrent decision on one customer (503) keeps the dialog open to try again.
 */
export function AttributionDecideDialogs({
  request,
  query,
  csrfToken,
  labelOf,
  onClose,
  onDone,
}: {
  /** The decision to confirm; null closes the dialog. */
  readonly request: DecideRequest | null;
  readonly query: AttributionQuery;
  readonly csrfToken: string;
  /** A customer's name for the result list, when the page knows it. */
  readonly labelOf: (accountId: string) => string | null;
  readonly onClose: () => void;
  /** After at least one request went through (the list reloads and the selection clears). */
  readonly onDone: () => void;
}) {
  const t = useTranslations('customers.attributions.decide');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const busy = useRef(false);
  // The confirm dialog keeps its words while it closes after a result.
  const shown = useRef<DecideRequest | null>(null);
  if (request !== null) shown.current = request;
  const current = request ?? shown.current;
  const count =
    current === null
      ? 0
      : current.target.kind === 'ids'
        ? current.target.ids.length
        : current.target.total;

  async function run() {
    if (request === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const { decision, target } = request;
    let ids: readonly string[];
    if (target.kind === 'ids') {
      ids = target.ids;
    } else {
      const matched = await callApi<{ ids: string[]; total: number }>(
        'POST',
        'customers/admin/seller-attributions/list/ids',
        attributionSelectorOf(query),
        csrfToken,
      );
      if (!matched.ok) {
        busy.current = false;
        setPending(false);
        if (matched.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setError(
          matched.failure.code === 'batch.too-large'
            ? t('error.too-large', {
                max: matched.failure.details?.max ?? 0,
                total: matched.failure.details?.total ?? 0,
              })
            : matched.failure.status === 429
              ? t('error.throttled', { minutes: minutesOf(matched.failure, 60) })
              : t('error.unavailable'),
        );
        return;
      }
      ids = matched.body.ids;
    }
    const counts: Record<DecisionOutcome, number> = {
      changed: 0,
      unchanged: 0,
      'not-found': 0,
      'seller-team': 0,
    };
    const unchanged: { accountId: string; outcome: DecisionOutcome }[] = [];
    let sent = 0;
    let failed: string | null = null;
    for (let start = 0; start < ids.length; start += DECIDE_MAX) {
      const chunk = ids.slice(start, start + DECIDE_MAX);
      const result = await callApi<DecisionAnswer>(
        'POST',
        'customers/admin/seller-attributions/decide',
        { decision, accountIds: chunk },
        csrfToken,
      );
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        failed =
          result.failure.code === 'customers.unavailable'
            ? t('error.busy')
            : result.failure.status === 403
              ? t('error.denied')
              : result.failure.status === 429
                ? t('error.throttled', { minutes: minutesOf(result.failure, 60) })
                : t('error.unavailable');
        break;
      }
      sent += chunk.length;
      for (const row of result.body.results) {
        counts[row.outcome] += 1;
        if (row.outcome !== 'changed')
          unchanged.push({ accountId: row.accountId, outcome: row.outcome });
      }
    }
    busy.current = false;
    setPending(false);
    if (failed !== null && sent === 0) {
      // Nothing went through: the dialog stays open to try again.
      setError(failed);
      return;
    }
    setSummary({
      decision,
      counts,
      unchanged,
      notSent: failed === null ? null : ids.length - sent,
    });
    if (failed !== null) toast.error(failed, { id: 'attributions-decide' });
    onDone();
    onClose();
  }

  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };

  return (
    <>
      <ConfirmAction
        open={request !== null}
        level={2}
        title={current === null ? '' : t(`${current.decision}.title`, { count })}
        body={
          current === null ? null : (
            <div className="flex flex-col gap-2">
              <p>{t(`${current.decision}.body`, { count })}</p>
              {current.target.kind === 'matching' && count > DECIDE_MAX ? (
                <p className="text-sm text-fg-muted">{t('chunks', { size: DECIDE_MAX })}</p>
              ) : null}
            </div>
          )
        }
        rowName=""
        confirmLabel={current === null ? '' : t(`${current.decision}.confirm`)}
        cancelLabel={t('cancel')}
        pending={pending}
        error={error}
        onConfirm={() => void run()}
        onCancel={close}
      />
      <Dialog
        open={summary !== null}
        title={summary === null ? '' : t(`${summary.decision}.result-title`)}
        onClose={() => setSummary(null)}
        actions={<Button onClick={() => setSummary(null)}>{t('close')}</Button>}
      >
        {summary === null ? null : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1">
              {OUTCOMES.filter((outcome) => summary.counts[outcome] > 0).map((outcome) => (
                <li key={outcome}>
                  {t(`outcome.${outcome}.${summary.decision}`, { count: summary.counts[outcome] })}
                </li>
              ))}
              {summary.notSent === null ? null : (
                <li role="alert" className="text-critical-fg">
                  {t('not-sent', { count: summary.notSent })}
                </li>
              )}
            </ul>
            {summary.unchanged.length === 0 ? null : (
              <div>
                <p className="mb-1 text-sm font-medium">{t('unchanged-list')}</p>
                <ul className="flex flex-col gap-1 text-sm">
                  {summary.unchanged.slice(0, LISTED_MAX).map((row) => (
                    <li key={row.accountId} className="wrap-anywhere">
                      {labelOf(row.accountId) ?? row.accountId}
                      {' - '}
                      {t(`outcome-short.${row.outcome}`)}
                    </li>
                  ))}
                </ul>
                {summary.unchanged.length > LISTED_MAX ? (
                  <p className="mt-1 text-sm text-fg-muted">
                    {t('and-more', { count: summary.unchanged.length - LISTED_MAX })}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
