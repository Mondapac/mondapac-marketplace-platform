'use client';

import { Button, Dialog, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { numberFormat } from '../shared/intl.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { bulkReasonKey, notifyChanged, shortCode } from './errors.ts';
import {
  BASE,
  countText,
  has,
  matchingBody,
  shortRef,
  type BulkAnswer,
  type BulkMatchingAnswer,
  type Query,
  type SystemRequest,
} from './types.ts';

/** The most calls "approve all matching" makes in one go: 100 requests each, the 10,000 cap. */
const MAX_ROUNDS = 100;

interface Failure {
  readonly id: string;
  readonly code: string;
}

interface Outcome {
  readonly approved: number;
  readonly total: number;
  readonly failed: readonly Failure[];
  /** The loop stopped before the filter was used up (an error, or nothing could be approved). */
  readonly stopped: boolean;
}

/**
 * The bulk bar over the table (a region named "Bulk actions"): how many rows are selected, "Approve
 * selected" and Clear. Bulk approve takes low-risk requests only, so with anything else selected
 * the button stays visible but disabled, with the reason and a link that deselects what cannot be
 * approved. "Select all matching" (offered once a page is ticked and the filter has more rows)
 * approves every low-risk request the filter matches, 100 per call, until none remain.
 */
export function QueueBulk({
  ids,
  allMatching,
  matchingTotal,
  rowOf,
  query,
  zone,
  csrfToken,
  canOfferAll,
  onSelectAll,
  onClear,
  onDeselect,
  onKeepOnly,
  onChanged,
}: {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** How many requests the view and filters match (capped at 10,000). */
  readonly matchingTotal: number;
  /** A selected row by id, from any page the admin ticked it on. */
  readonly rowOf: (id: string) => SystemRequest | undefined;
  readonly query: Query;
  readonly zone: string;
  readonly csrfToken: string;
  /** The page is fully ticked and the filter holds more rows than are selected. */
  readonly canOfferAll: boolean;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  /** Takes these ids out of the selection. */
  readonly onDeselect: (ids: readonly string[]) => void;
  /** After a mixed result: only the ids that failed stay selected. */
  readonly onKeepOnly: (ids: readonly string[]) => void;
  /** Requests were approved: the list loads again. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('system-requests.bulk');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [dialog, setDialog] = useState<'confirm' | 'result' | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inFlight = useRef(false);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const blocked = ids.filter((id) => {
    const row = rowOf(id);
    return row === undefined || row.risk !== 'low' || !has(row, 'approve');
  });
  const count = allMatching ? matchingTotal : ids.length;
  const countLabel = countText(count, number);
  const approvable = allMatching || (ids.length > 0 && blocked.length === 0);
  const labelOf = (id: string) => rowOf(id)?.displayNumber ?? shortRef(id);

  // The dialogs outlive the selection: a finished approval clears it and still shows its result.
  const showBar = ids.length > 0 || allMatching;

  async function approveSelected() {
    const sent = [...ids];
    const result = await guarded<BulkAnswer>(
      'POST',
      `${BASE}/requests/bulk-approve`,
      { requestIds: sent },
      csrfToken,
    );
    if (!result.ok) return result;
    const failed = result.body.results
      .filter((entry) => entry.outcome !== 'approved')
      .map((entry) => ({ id: entry.requestId, code: entry.outcome }));
    return {
      ok: true as const,
      outcome: {
        approved: sent.length - failed.length,
        total: sent.length,
        failed,
        stopped: false,
      },
    };
  }

  async function approveMatching() {
    let approved = 0;
    const failed: Failure[] = [];
    let stopped = false;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await guarded<BulkMatchingAnswer>(
        'POST',
        `${BASE}/requests/bulk-approve-matching`,
        matchingBody(query, zone),
        csrfToken,
      );
      if (!result.ok) {
        if (isStepUpCancelled(result) || round === 0) return result;
        stopped = true;
        break;
      }
      approved += result.body.approved;
      for (const entry of result.body.failed) {
        if (!failed.some((known) => known.id === entry.id)) failed.push(entry);
      }
      setProgress(approved);
      if (result.body.remaining <= 0) break;
      // Nothing was approved this round: the rest cannot be, and another call would repeat it.
      if (result.body.approved === 0) {
        stopped = true;
        break;
      }
      if (round === MAX_ROUNDS - 1) stopped = true;
    }
    return {
      ok: true as const,
      outcome: { approved, total: approved + failed.length, failed, stopped },
    };
  }

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProgress(0);
    const result = await (allMatching ? approveMatching() : approveSelected());
    inFlight.current = false;
    setBusy(false);
    if (!('outcome' in result)) {
      setDialog(null);
      if (isStepUpCancelled(result)) return;
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      toast.error(t(result.failure.code === 'network' ? 'error.network' : 'error.unavailable'));
      return;
    }
    const { outcome: done } = result;
    if (done.approved > 0) {
      notifyChanged();
      onChanged();
    }
    if (done.failed.length === 0 && !done.stopped) {
      setDialog(null);
      toast.success(t('done', { count: done.approved }));
      onClear();
      return;
    }
    setOutcome(done);
    setDialog('result');
    if (!allMatching) onKeepOnly(done.failed.map((entry) => entry.id));
    else onClear();
  }

  const reasonOf = (code: string) => {
    const key = bulkReasonKey(code);
    return key === 'other' ? t('reason.other', { code: shortCode(code) }) : t(`reason.${key}`);
  };

  return (
    <>
      {showBar ? (
        <div
          role="region"
          aria-label={t('region')}
          className="sticky bottom-3 z-10 flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 shadow-(--mp-shadow-elevation-floating)"
        >
          <div className="flex flex-wrap items-center gap-3">
            <p aria-live="polite" className="text-sm font-medium text-fg">
              {allMatching
                ? t('selected-all', { count: countLabel })
                : t('selected', { count: ids.length })}
            </p>
            {canOfferAll && !allMatching ? (
              <Button variant="link" className="min-h-(--mp-size-control-sm)" onClick={onSelectAll}>
                {t('select-all', { count: countText(matchingTotal, number) })}
              </Button>
            ) : null}
            <div className="ms-auto flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={onClear}>
                {t('clear')}
              </Button>
              <Button
                disabled={!approvable || busy}
                aria-describedby={approvable ? undefined : 'sr-bulk-reason'}
                onClick={() => setDialog('confirm')}
              >
                {allMatching ? t('approve-matching') : t('approve-selected')}
              </Button>
            </div>
          </div>
          {approvable ? null : (
            <p id="sr-bulk-reason" className="text-sm text-fg-muted">
              {t('not-allowed')}{' '}
              {blocked.length > 0 ? (
                <Button
                  variant="link"
                  className="min-h-(--mp-size-control-sm) align-baseline"
                  onClick={() => onDeselect(blocked)}
                >
                  {t('deselect', { count: blocked.length })}
                </Button>
              ) : null}
            </p>
          )}
        </div>
      ) : null}
      {dialog === 'confirm' ? (
        <Dialog
          open
          title={allMatching ? t('confirm.title-matching') : t('confirm.title', { count })}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          actions={
            <>
              <Button variant="secondary" autoFocus disabled={busy} onClick={() => setDialog(null)}>
                {t('cancel')}
              </Button>
              <Button loading={busy} onClick={() => void confirm()}>
                {allMatching ? t('confirm.matching') : t('confirm.action', { count })}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <p>{allMatching ? t('confirm.body-matching') : t('confirm.body')}</p>
            {allMatching && busy ? <p role="status">{t('progress', { count: progress })}</p> : null}
          </div>
        </Dialog>
      ) : null}
      {dialog === 'result' && outcome !== null ? (
        <Dialog
          open
          title={t('result.title', { approved: outcome.approved, total: outcome.total })}
          onClose={() => setDialog(null)}
          actions={<Button onClick={() => setDialog(null)}>{t('result.done')}</Button>}
        >
          <div className="flex flex-col gap-3">
            {outcome.stopped ? <p>{t('result.stopped')}</p> : null}
            <ul className="flex flex-col gap-2">
              {outcome.failed.map((entry) => (
                <li key={entry.id}>
                  <span className="font-medium text-fg">{labelOf(entry.id)}</span>{' '}
                  <span>{reasonOf(entry.code)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
