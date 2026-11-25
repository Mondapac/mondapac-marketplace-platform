'use client';

import { Banner, Button, Dialog, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
import { exponentOf, inputOf } from '../shipping/money.ts';

// The Market's monthly revenue target, edited from the dashboard's Monthly target card (dashboards
// v2, phase 2). GET and PUT settings/admin/monthly-revenue-target (keys
// settings.monthly-revenue-target.view and .manage): the dialog reads the target, its version and
// whether a change is reviewed when it opens, and sends the version it read, so a stale edit is
// refused (409). The currency is the Market's, taken from the KPI answer (the settings read does
// not name it while no target is set). A change may wait in Admin Inbox > System requests; the
// card shows the target in force, so it is read again after a save.

export const TARGET_PATH = 'settings/admin/monthly-revenue-target';

export interface MonthlyRevenueTarget {
  readonly target: { readonly amount: string; readonly currency: string } | null;
  /** 0 while no target was ever set. */
  readonly version: number;
  readonly updatedAt: string | null;
  readonly review: { readonly reviewed: boolean; readonly risk: string };
}

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'settings.conflict': 'conflict',
  'system-requests.already-pending': 'pending',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
};

/** The message key (under `dashboard.kpis.target.editor.error`) for a refused target write. */
export function targetProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 403) return 'denied';
  if (failure.status === 409) return 'conflict';
  if (failure.status === 429) return 'throttled';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/**
 * What the admin typed ("240000", "240000.50") as minor units in the currency, or null when it is
 * not an amount above zero with at most the currency's decimals and 15 digits. Exact: no floats.
 */
export function targetMinorOf(text: string, currency: string): string | null {
  let exponent: number;
  try {
    exponent = exponentOf(currency);
  } catch {
    return null;
  }
  const typed = text.trim();
  // A comma only as a thousands separator ("240,000.50"); "240000,50" is refused, never read as
  // 24,000,050.
  if (!/^\d+(\.\d+)?$/.test(typed) && !/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(typed)) return null;
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(typed.replaceAll(',', ''));
  if (match === null) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return null;
  const digits = `${match[1] as string}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(digits) || digits.length > 15) return null;
  return digits;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ok'; readonly value: MonthlyRevenueTarget };

/** "Edit" on the Monthly target card: opens the dialog. */
export function TargetEditButton({
  currency,
  csrfToken,
}: {
  readonly currency: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('dashboard.kpis.target');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="min-h-11 min-w-11 lg:min-h-0 lg:min-w-0"
        onClick={() => setOpen(true)}
      >
        {t('edit')}
      </Button>
      {open ? (
        <TargetDialog currency={currency} csrfToken={csrfToken} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function TargetDialog({
  currency,
  csrfToken,
  onClose,
}: {
  readonly currency: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('dashboard.kpis.target.editor');
  const router = useRouter();
  const sentForReview = useSentForReview();
  const formId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const [fieldError, setFieldError] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoaded({ kind: 'loading' });
    const answer = await callApi<MonthlyRevenueTarget>('GET', TARGET_PATH);
    if (answer.ok) {
      setLoaded({ kind: 'ok', value: answer.body });
      setText(
        answer.body.target === null
          ? ''
          : inputOf(answer.body.target.amount, answer.body.target.currency),
      );
      setProblem(null);
      return;
    }
    if (answer.failure.status === 401) window.location.assign('/session-ended');
    else setLoaded({ kind: 'failed' });
  }

  useEffect(() => {
    // Read once when the dialog opens.
    void load();
  }, []);

  useEffect(() => {
    if (problem !== null) alertRef.current?.focus();
  }, [problem]);

  async function save(clear: boolean) {
    if (busy.current || loaded.kind !== 'ok') return;
    const amount = clear ? null : targetMinorOf(text, currency);
    if (!clear && amount === null) {
      setFieldError(true);
      return;
    }
    setFieldError(false);
    const reviewed = loaded.value.review.reviewed;
    const sent = reviewed ? trimmedNote(note) : null;
    if (reviewed && sent === null) {
      setNoteError('required');
      return;
    }
    setNoteError(null);
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<MonthlyRevenueTarget & { request?: unknown }>(
      'PUT',
      TARGET_PATH,
      {
        target: amount === null ? null : { amount, currency },
        expectedVersion: loaded.value.version,
        ...(sent === null ? {} : { note: sent }),
      },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      if (!sentForReview(result.body)) toast.success(t('saved'));
      onClose();
      router.refresh();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (isNoteFailure(result.failure)) {
      setNoteError('rejected');
      return;
    }
    const code = targetProblemOf(result.failure);
    if (code === 'invalid') setFieldError(true);
    else setProblem(code);
  }

  const ready = loaded.kind === 'ok';
  const hasTarget = ready && loaded.value.target !== null;
  return (
    <Dialog
      open
      title={t('title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          {hasTarget ? (
            <Button variant="secondary" onClick={() => void save(true)} disabled={pending}>
              {t('clear')}
            </Button>
          ) : null}
          <Button type="submit" form={formId} loading={pending} disabled={!ready}>
            {t('save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        {loaded.kind === 'loading' ? (
          <p role="status" className="m-0 text-sm text-fg-muted">
            {t('loading')}
          </p>
        ) : null}
        {loaded.kind === 'failed' ? (
          <Banner tone="critical">
            {t('load-failed')}{' '}
            <Button variant="secondary" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </Banner>
        ) : null}
        {problem === null ? null : (
          <div ref={alertRef} tabIndex={-1} className="outline-none">
            <Banner tone="critical">
              {t(`error.${problem}` as 'error.unknown')}
              {problem === 'conflict' ? (
                <>
                  {' '}
                  <Button variant="secondary" onClick={() => void load()}>
                    {t('reload')}
                  </Button>
                </>
              ) : null}
            </Banner>
          </div>
        )}
        {ready ? (
          <>
            <TextField
              name="target"
              label={t('field', { currency })}
              help={t('field-help', { currency })}
              inputMode="decimal"
              autoComplete="off"
              dir="ltr"
              value={text}
              disabled={pending}
              error={fieldError ? t('error.amount') : undefined}
              onChange={(event) => setText(event.target.value)}
            />
            {loaded.value.review.reviewed ? (
              <ReviewNoteField
                value={note}
                onChange={(next) => {
                  setNote(next);
                  setNoteError(null);
                }}
                error={noteError ?? undefined}
                disabled={pending}
              />
            ) : null}
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
