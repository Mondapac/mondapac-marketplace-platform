'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';

export interface BulkRow {
  readonly id: string;
  readonly version: number;
}
export interface BulkCounts {
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}
interface BulkAnswer {
  readonly action: string;
  readonly counts: BulkCounts;
}

/**
 * The bulk decision of a queue (accept or reject the ticked rows of the page, at most 50): a level
 * 2 confirmation that names how many rows and what follows, with focus on Cancel and a red
 * confirm. The server decides each row through the queue's own single decision, as the caller; a row
 * that changed or was decided meanwhile is skipped, never forced. The answer is told in the dialog
 * (done, skipped, failed) and closing it reads the list again.
 */
export function BulkDecideDialog({
  endpoint,
  action,
  rows,
  title,
  body,
  confirm,
  fields,
  extraBody = {},
  ready = true,
  csrfToken,
  onClose,
  onFinished,
}: {
  /** The queue's bulk route, for example `catalog/admin/variant-requests/bulk-decide`. */
  readonly endpoint: string;
  readonly action: string;
  readonly rows: readonly BulkRow[];
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  /** The fields the decision needs (a reason, a group); their values go in `extraBody`. */
  readonly fields?: React.ReactNode;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** The fields are filled in. */
  readonly ready?: boolean;
  readonly csrfToken: string;
  /** Closed without a decision, or after the answer was read. */
  readonly onClose: () => void;
  /** At least one row was decided (the list is read again). */
  readonly onFinished: () => void;
}) {
  const t = useTranslations('bulk-decide');
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [counts, setCounts] = useState<BulkCounts | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    if (busy.current || !ready) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<BulkAnswer>(
      'POST',
      endpoint,
      { action, items: rows.map(({ id, version }) => ({ id, version })), ...extraBody },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setCounts(result.body.counts);
      onFinished();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(
      result.failure.code === 'batch.too-large'
        ? 'too-large'
        : result.failure.code === 'access.denied'
          ? 'denied'
          : result.failure.code === 'validation.failed'
            ? 'invalid'
            : result.failure.status === 0 || result.failure.status >= 500
              ? 'unavailable'
              : 'unknown',
    );
  }

  return (
    <Dialog
      open
      size="form"
      title={counts === null ? title : t('done.title')}
      onClose={() => {
        if (!pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        counts === null ? (
          <>
            <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive-solid"
              loading={pending}
              disabled={!ready || pending}
              onClick={() => void submit()}
            >
              {confirm}
            </Button>
          </>
        ) : (
          <Button ref={cancel} onClick={onClose}>
            {t('close')}
          </Button>
        )
      }
    >
      {counts === null ? (
        <div className="flex flex-col gap-3">
          <p className="wrap-anywhere">{body}</p>
          <p className="text-sm text-fg-muted">{t('note', { count: rows.length })}</p>
          {problem === null ? null : (
            <div role="alert">
              <Banner tone="critical">{t(`error.${problem}`)}</Banner>
            </div>
          )}
          {fields}
        </div>
      ) : (
        <div className="flex flex-col gap-3" role="status">
          <p>{t('done.summary', { done: counts.done, skipped: counts.skipped })}</p>
          {counts.failed > 0 ? (
            <Banner tone="critical">{t('done.failed', { count: counts.failed })}</Banner>
          ) : null}
          {counts.skipped > 0 ? (
            <p className="text-sm text-fg-muted">{t('done.skipped-help')}</p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
