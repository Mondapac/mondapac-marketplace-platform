'use client';

import { Banner, Button, Dialog, SkeletonRows, TextAreaField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { CategoryProblemBanner } from './category-problem.tsx';
import {
  MAX_MISSES,
  POLL_MS,
  handled,
  isFinished,
  jobOf,
  moveTargetRows,
  newestRunning,
  pathLabel,
} from './move-products-model.ts';
import { TargetPicker } from './restructure-dialog.tsx';
import { checkReason, reasonOf } from './restructure-model.ts';
import { useCategoryCall } from './use-category-call.ts';
import {
  API_CATEGORIES,
  type CategoryRow,
  type ImpactBody,
  type MoveJob,
  type MoveProgressBody,
  type MoveStarted,
} from './types.ts';

type CountState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly products: number; readonly complete: boolean };

/** The published products directly in the category: the "direct products" count of the impact read. */
function useProductCount(categoryId: string): CountState {
  const [state, setState] = useState<CountState>({ kind: 'loading' });
  useEffect(() => {
    let current = true;
    void callApi<ImpactBody>(
      'GET',
      `${API_CATEGORIES}/${categoryId}/impact?${new URLSearchParams({ action: 'archive' }).toString()}`,
    ).then((result) => {
      if (!current) return;
      if (result.ok) {
        setState({
          kind: 'ready',
          products: result.body.directProducts,
          complete: result.body.complete,
        });
      } else if (result.failure.status === 401) window.location.assign('/session-ended');
      else setState({ kind: 'failed' });
    });
    return () => {
      current = false;
    };
  }, [categoryId]);
  return state;
}

type Progress =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'job'; readonly job: MoveJob; readonly unreadable: boolean }
  | { readonly kind: 'unreadable' }
  /** The category is gone (404): reading stops and the admin is asked to reload. */
  | { readonly kind: 'gone' };

/**
 * Reads the progress of the job until it is done or failed; a read that fails is tried again.
 * A job that is not in the newest list after several reads, or a 404, ends the waiting; reads
 * pause while the tab is hidden and go on when it is shown.
 */
function useJobProgress(categoryId: string, jobId: string | null): Progress {
  const [state, setState] = useState<Progress>({ kind: 'waiting' });
  useEffect(() => {
    if (jobId === null) return;
    const wanted: string = jobId;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    let sleeping = false;
    function schedule(): void {
      timer = setTimeout(() => {
        if (document.hidden) sleeping = true;
        else void read();
      }, POLL_MS);
    }
    async function read(): Promise<void> {
      sleeping = false;
      const result = await callApi<MoveProgressBody>(
        'GET',
        `${API_CATEGORIES}/${categoryId}/move-products`,
      );
      if (!current) return;
      let finished = false;
      if (result.ok) {
        const job = jobOf(result.body, wanted);
        if (job === null) {
          misses += 1;
          setState(misses >= MAX_MISSES ? { kind: 'unreadable' } : { kind: 'waiting' });
        } else {
          misses = 0;
          setState({ kind: 'job', job, unreadable: false });
          finished = isFinished(job);
        }
      } else if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      } else if (result.failure.status === 404) {
        setState({ kind: 'gone' });
        return;
      } else {
        setState((previous) =>
          previous.kind === 'job'
            ? { kind: 'job', job: previous.job, unreadable: true }
            : { kind: 'unreadable' },
        );
      }
      if (!finished) schedule();
    }
    const onVisible = (): void => {
      if (!document.hidden && sleeping && current) void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    void read();
    return () => {
      current = false;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [categoryId, jobId]);
  return state;
}

function ProgressView({
  progress,
  expected,
  name,
  earlier,
  onReload,
}: {
  readonly progress: Progress;
  /** The count the start answered with, shown until the job itself is read. */
  readonly expected: number;
  readonly name: string;
  /** The admin attached to a move somebody started earlier. */
  readonly earlier: boolean;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.move-products');
  const job = progress.kind === 'job' ? progress.job : null;
  const total = job?.total ?? expected;
  const state = job?.state ?? 'queued';
  return (
    <div className="flex flex-col gap-3" data-testid="move-products-progress">
      {earlier ? <Banner tone="attention">{t('attached-note')}</Banner> : null}
      {/* A job that cannot be read is not "waiting to start": the banner below says what is known. */}
      {progress.kind === 'unreadable' || progress.kind === 'gone' ? null : (
        <p role="status" className="m-0 font-medium">
          {t(`state.${state}`, {
            moved: job?.moved ?? 0,
            skipped: job?.skipped ?? 0,
            failed: job?.failed ?? 0,
          })}
        </p>
      )}
      <progress
        className="w-full"
        aria-label={t('progress-label')}
        max={Math.max(total, 1)}
        value={job === null ? 0 : handled(job)}
      />
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>{t('count-total')}</dt>
        <dd className="m-0">{total}</dd>
        <dt>{t('count-moved')}</dt>
        <dd className="m-0">{job?.moved ?? 0}</dd>
        <dt>{t('count-skipped')}</dt>
        <dd className="m-0">{job?.skipped ?? 0}</dd>
        <dt>{t('count-failed')}</dt>
        <dd className="m-0">{job?.failed ?? 0}</dd>
      </dl>
      {state === 'failed' ? <Banner tone="critical">{t('failed-body')}</Banner> : null}
      {state === 'done' && job !== null && job.skipped > 0 ? (
        <Banner tone="info">{t('skipped-note', { name })}</Banner>
      ) : null}
      {state === 'done' && job !== null && job.failed > 0 ? (
        <Banner tone="attention">{t('failed-note')}</Banner>
      ) : null}
      {progress.kind === 'unreadable' || (progress.kind === 'job' && progress.unreadable) ? (
        <Banner tone="attention">{t('progress-unreadable')}</Banner>
      ) : null}
      {progress.kind === 'gone' ? (
        <div className="flex flex-col items-start gap-2">
          <Banner tone="attention">{t('progress-gone')}</Banner>
          <Button onClick={onReload}>{t('reload')}</Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Move products…" of a category (categories C5b): pick the target (level 3 or 4, hidden allowed),
 * see how many published products move, give a reason of 10 to 500 characters and start the job;
 * then watch it run (queued, running, done or failed, with the counts). The reason is for the audit
 * log only: no seller sees it.
 */
export function MoveProductsDialog({
  categoryId,
  name,
  rows,
  locale,
  csrfToken,
  onClose,
  onReload,
}: {
  readonly categoryId: string;
  readonly name: string;
  /** Every category of the tree, in tree order. */
  readonly rows: readonly CategoryRow[];
  /** The language the names are shown in. */
  readonly locale: string;
  readonly csrfToken: string;
  /** `started`: a job was queued, so the owner reads the tree (and its counts) again. */
  readonly onClose: (started: boolean) => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.move-products');
  const call = useCategoryCall(csrfToken, 'move-products');
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [started, setStarted] = useState<MoveStarted | null>(null);
  // The admin looked at a move that was already running (409): never attached without asking.
  const [earlier, setEarlier] = useState(false);
  const [lookup, setLookup] = useState<'idle' | 'reading' | 'none' | 'failed'>('idle');
  const candidates = useMemo(() => moveTargetRows(rows, categoryId), [rows, categoryId]);
  const count = useProductCount(categoryId);
  const progress = useJobProgress(categoryId, started?.jobId ?? null);
  const targetPath = target === null ? '' : pathLabel(rows, target, locale);
  const noProducts = count.kind === 'ready' && count.products === 0;
  const reasonState = checkReason(reason);
  const ready = reasonState === 'ok' && target !== null && !noProducts;
  const note = noProducts
    ? t('need-products')
    : target === null
      ? t('need-target')
      : reasonState !== 'ok'
        ? t('need-reason')
        : undefined;
  const noteId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const finished = progress.kind === 'job' && isFinished(progress.job);

  // The form is gone once the job is queued: focus goes to the progress heading, not to the page.
  useEffect(() => {
    if (started !== null) heading.current?.focus();
  }, [started]);

  const inProgress =
    call.problem?.key === 'categories.move-products.error.category_move-in-progress';

  async function viewProgress() {
    setLookup('reading');
    const result = await callApi<MoveProgressBody>(
      'GET',
      `${API_CATEGORIES}/${categoryId}/move-products`,
    );
    if (result.ok) {
      const running = newestRunning(result.body);
      if (running === null) setLookup('none');
      else {
        setEarlier(true);
        setStarted({ jobId: running.id, products: running.total });
      }
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setLookup('failed');
  }

  async function submit() {
    if (!ready || target === null) return;
    const answer = await call.run<MoveStarted>(
      'POST',
      `${API_CATEGORIES}/${categoryId}/move-products`,
      {
        targetId: target,
        reason: reasonOf(reason),
      },
    );
    if (answer.ok) setStarted(answer.body);
  }

  const reasonError =
    reasonState === 'long'
      ? t('reason-long')
      : touched && reasonState === 'short'
        ? t('reason-short')
        : undefined;
  const problem = call.problem;

  return (
    <Dialog
      open
      title={t('title', { name })}
      // A start that is still being sent is not abandoned by Escape or a click on the backdrop.
      onClose={() => {
        if (!call.pending) onClose(started !== null);
      }}
      {...(started === null && note !== undefined
        ? { actionsNote: <span id={noteId}>{note}</span> }
        : {})}
      actions={
        started === null ? (
          <>
            <Button variant="secondary" disabled={call.pending} onClick={() => onClose(false)}>
              {t('cancel')}
            </Button>
            {problem?.reload === true ? (
              <Button onClick={onReload}>{t('reload')}</Button>
            ) : (
              <Button
                loading={call.pending}
                disabled={!ready}
                aria-describedby={note === undefined ? undefined : noteId}
                onClick={() => void submit()}
              >
                {t('action')}
              </Button>
            )}
          </>
        ) : (
          <Button variant={finished ? 'primary' : 'secondary'} onClick={() => onClose(true)}>
            {t('close')}
          </Button>
        )
      }
    >
      {started === null ? (
        <div className="flex flex-col gap-4">
          {inProgress && lookup === 'none' ? (
            <div className="flex flex-col items-start gap-2">
              <Banner tone="attention">{t('attach-finished')}</Banner>
              <Button onClick={onReload}>{t('reload')}</Button>
            </div>
          ) : (
            <>
              <CategoryProblemBanner problem={problem} />
              {inProgress ? (
                <div className="flex flex-col items-start gap-2">
                  {lookup === 'failed' ? (
                    <p role="alert" className="m-0 text-sm text-critical-fg">
                      {t('view-failed')}
                    </p>
                  ) : null}
                  <Button
                    variant="secondary"
                    loading={lookup === 'reading'}
                    onClick={() => void viewProgress()}
                  >
                    {t('view-progress')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
          <p className="m-0">{t('intro', { name })}</p>
          <TargetPicker
            legend={t('target')}
            rows={candidates}
            locale={locale}
            value={target}
            withTop={false}
            disabled={call.pending}
            onChange={(value) => {
              // A refusal belongs to the earlier choice.
              call.clear();
              setLookup('idle');
              setTarget(value);
            }}
          />
          <section aria-labelledby={`${noteId}-count`} className="flex flex-col gap-2">
            <h3 id={`${noteId}-count`} className="m-0 text-base font-semibold">
              {t('count-title')}
            </h3>
            {count.kind === 'loading' ? (
              <SkeletonRows label={t('count-loading')} rows={1} />
            ) : count.kind === 'failed' ? (
              <Banner tone="attention">{t('count-error')}</Banner>
            ) : count.products === 0 ? (
              <p className="m-0" data-testid="move-products-count">
                {t('count-none', { name })}
              </p>
            ) : (
              <p className="m-0" data-testid="move-products-count">
                {target === null
                  ? count.complete
                    ? t('count', { n: count.products })
                    : t('count-at-least', { n: count.products })
                  : count.complete
                    ? t('count-to', { n: count.products, name, target: targetPath })
                    : t('count-at-least-to', { n: count.products, name, target: targetPath })}
              </p>
            )}
          </section>
          <TextAreaField
            label={t('reason')}
            help={t('reason-help')}
            counter={t('reason-counter', { n: reasonOf(reason).length })}
            error={reasonError}
            rows={4}
            value={reason}
            required
            autoComplete="off"
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <h3 ref={heading} tabIndex={-1} className="m-0 text-base font-semibold">
            {t('progress-title')}
          </h3>
          <ProgressView
            progress={progress}
            expected={started.products}
            name={name}
            earlier={earlier}
            onReload={onReload}
          />
          {finished ? null : <p className="m-0 text-sm text-fg-muted">{t('keeps-running')}</p>}
        </div>
      )}
    </Dialog>
  );
}
