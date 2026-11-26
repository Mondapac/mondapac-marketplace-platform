'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';

export interface BulkRow {
  readonly id: string;
  readonly version: number;
  /** The revision a decision names, for a queue of product revisions. */
  readonly revisionId?: string;
}
export interface BulkCounts {
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}
interface BulkAnswer {
  readonly action: string;
  readonly counts: BulkCounts;
  /** One entry per row: what happened and, when it was not decided, a stable reason code. */
  readonly results?: readonly BulkResult[];
}
/** One row's result; `name` and `blockers` come with the Offer review queue only. */
export interface BulkResult {
  readonly id: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly name?: string | null;
  readonly blockers?: readonly string[];
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
  toItem = ({ id, version }) => ({ id, version }),
  reasonText,
  describeSkipped,
  ready = true,
  confirmVariant = 'destructive-solid',
  sendAction = true,
  doneTitle,
  csrfToken,
  onClose,
  onFinished,
}: {
  /** The queue's bulk route, for example `catalog/admin/variant-requests/bulk-decide`. */
  readonly endpoint: string;
  readonly action: string;
  readonly rows: readonly BulkRow[];
  /** The body of one item when it needs more than `{ id, version }` (a revision names its id). */
  readonly toItem?: (row: BulkRow) => Record<string, unknown>;
  /**
   * The sentence for the rows that were not decided for one reason code (`count` rows), or null to
   * leave that code unexplained. The default help line is told for the rest.
   */
  readonly reasonText?: (reason: string, count: number) => string | null;
  /**
   * The line for one row that was not decided (its name and why), or null for none. When it gives
   * any, the answer lists those rows under "Skipped rows" so the reviewer can open them one by one.
   */
  readonly describeSkipped?: (entry: BulkResult) => string | null;
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  /** The fields the decision needs (a reason, a group); their values go in `extraBody`. */
  readonly fields?: React.ReactNode;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** The fields are filled in. */
  readonly ready?: boolean;
  /** The confirm button: red by default (a rejection); a plain approval is the primary button. */
  readonly confirmVariant?: 'primary' | 'destructive-solid';
  /**
   * The body names the decision as `action` (default). A route that does one thing only (the
   * post-publication bulk approve) takes closed bodies without it: pass false.
   */
  readonly sendAction?: boolean;
  /** The answer's title from its counts ("2 approved, 1 skipped"); default "Decision made". */
  readonly doneTitle?: (counts: BulkCounts) => string;
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
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    if (busy.current || !ready) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<BulkAnswer>(
      'POST',
      endpoint,
      {
        ...(sendAction ? { action } : {}),
        items: rows.map((row) => toItem(row)),
        ...extraBody,
      },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      const reasons = new Map<string, number>();
      for (const entry of result.body.results ?? []) {
        if (entry.outcome !== 'done' && entry.reason !== undefined) {
          reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
        }
      }
      setNotes(
        reasonText === undefined
          ? []
          : [...reasons].flatMap(([reason, count]) => reasonText(reason, count) ?? []),
      );
      setSkipped(
        describeSkipped === undefined
          ? []
          : (result.body.results ?? [])
              .filter((entry) => entry.outcome !== 'done')
              .flatMap((entry) => describeSkipped(entry) ?? []),
      );
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
      title={
        counts === null ? title : doneTitle === undefined ? t('done.title') : doneTitle(counts)
      }
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
              variant={confirmVariant}
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
          {notes.map((note) => (
            <Banner key={note} tone="attention">
              {note}
            </Banner>
          ))}
          {skipped.length > 0 ? (
            <section aria-label={t('done.skipped-rows')}>
              <h3 className="m-0 mb-1 text-sm font-semibold">{t('done.skipped-rows')}</h3>
              <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-sm">
                {skipped.map((line, index) => (
                  <li key={`${index}-${line}`} className="wrap-anywhere">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {counts.skipped > 0 && notes.length === 0 && skipped.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('done.skipped-help')}</p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
