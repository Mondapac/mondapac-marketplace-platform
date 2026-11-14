'use client';

import { Banner, Button, Dialog, Select, TextAreaField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type FormEvent } from 'react';
import { wordsFor } from './label.ts';
import {
  API_CERTIFICATES,
  REASON_TEXT_MAX,
  type CheckResultCode,
  type ReviewCheck,
  type ReviewReason,
} from './types.ts';
import { useReviewCall } from './use-review-call.ts';

const RESULTS: readonly CheckResultCode[] = ['done', 'problem', 'not-applicable'];

interface Common {
  readonly certificateId: string;
  readonly submissionId: string;
  readonly csrfToken: string;
}

/** The Market's checks, one result each. Saving one is immediate; the latest result counts. */
export function ChecksForm({
  certificateId,
  submissionId,
  csrfToken,
  checks,
  canRecord,
}: Common & { readonly checks: readonly ReviewCheck[]; readonly canRecord: boolean }) {
  const t = useTranslations('certificates.review.checks');
  const tr = useTranslations();
  const call = useReviewCall(csrfToken);
  const [saved, setSaved] = useState<Readonly<Record<string, CheckResultCode>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function record(checkCode: string, result: CheckResultCode) {
    setSaving(checkCode);
    setFailed(null);
    const answer = await call.run(`${API_CERTIFICATES}/${certificateId}/checks`, {
      submissionId,
      checkCode,
      result,
    });
    setSaving(null);
    if (answer.ok) setSaved((prev) => ({ ...prev, [checkCode]: result }));
    else setFailed(checkCode);
  }

  if (checks.length === 0) return <p className="text-fg-muted">{t('none')}</p>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {checks.map((check) => {
          const current = saved[check.code] ?? check.result;
          return (
            <li key={check.code} className="rounded-md border border-line p-3">
              <fieldset className="min-w-0" disabled={!canRecord || saving === check.code}>
                <legend className="text-sm font-medium wrap-anywhere">
                  {wordsFor(tr, 'check-code', check.code)}
                  {check.required ? (
                    <span className="font-normal text-fg-muted"> ({t('required')})</span>
                  ) : null}
                </legend>
                <div className="mt-2 flex flex-wrap gap-4">
                  {RESULTS.map((result) => (
                    <label key={result} className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`check-${check.code}`}
                        checked={current === result}
                        onChange={() => void record(check.code, result)}
                      />
                      {t(`result.${result}`)}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-fg-muted" aria-live="polite">
                  {saving === check.code
                    ? t('saving')
                    : current === null
                      ? t('not-recorded')
                      : t('recorded', { result: t(`result.${current}`) })}
                </p>
              </fieldset>
              {failed === check.code && call.problem !== null ? (
                <div className="mt-2">
                  <Banner tone="critical">
                    {t('failed')} {tr(call.problem.key as never)}
                  </Banner>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canRecord ? null : <p className="text-sm text-fg-muted">{t('view-only')}</p>}
    </div>
  );
}

/** The location and scope as read from the certificate (plain text; stored encrypted). */
export function ScopeForm({
  certificateId,
  submissionId,
  csrfToken,
  recorded,
  canRecord,
}: Common & { readonly recorded: boolean; readonly canRecord: boolean }) {
  const t = useTranslations('certificates.review.scope');
  const tr = useTranslations();
  const call = useReviewCall(csrfToken);
  const [location, setLocation] = useState('');
  const [scope, setScope] = useState('');
  const [checked, setChecked] = useState(false);
  const [done, setDone] = useState(false);
  if (!canRecord) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    setDone(false);
    if (location.trim() === '' || scope.trim() === '') return;
    const answer = await call.run(`${API_CERTIFICATES}/${certificateId}/scope`, {
      submissionId,
      location: location.trim(),
      scope: scope.trim(),
    });
    if (answer.ok) setDone(true);
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <div aria-live="polite">
        {call.problem === null ? null : (
          <Banner tone="critical">{tr(call.problem.key as never)}</Banner>
        )}
        {done ? <Banner tone="success">{t('saved')}</Banner> : null}
      </div>
      <p className="text-sm text-fg-muted">{recorded ? t('replace-note') : t('help')}</p>
      <TextAreaField
        label={t('location')}
        rows={2}
        value={location}
        onChange={(event) => {
          setLocation(event.target.value);
          setDone(false);
        }}
        error={checked && location.trim() === '' ? t('required') : undefined}
      />
      <TextAreaField
        label={t('scope')}
        rows={3}
        value={scope}
        onChange={(event) => {
          setScope(event.target.value);
          setDone(false);
        }}
        error={checked && scope.trim() === '' ? t('required') : undefined}
      />
      <div>
        <Button type="submit" variant="secondary" loading={call.pending} disabled={call.pending}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

type Decision = 'approve' | 'request-changes' | 'decline';

/**
 * Approve, request changes or decline. The three are separate choices, none preselected; the
 * confirmation names the record version read. Request changes and Decline need a prepared reason.
 * Approve stays reachable but says, as text, what has to be done first.
 */
export function DecisionForm({
  certificateId,
  submissionId,
  csrfToken,
  version,
  reasons,
  canDecide,
  blockers,
  store,
  typeName,
  submissionNo,
  renewal,
}: Common & {
  readonly version: number;
  readonly reasons: {
    readonly 'changes-requested'?: readonly ReviewReason[];
    readonly declined?: readonly ReviewReason[];
  };
  readonly canDecide: boolean;
  /** Why Approve can't be used yet, already worded. */
  readonly blockers: readonly string[];
  readonly store: string;
  readonly typeName: string;
  readonly submissionNo: number;
  readonly renewal: boolean;
}) {
  const t = useTranslations('certificates.review.decision');
  const [open, setOpen] = useState<Decision | null>(null);
  if (!canDecide) return <p className="text-fg-muted">{t('no-role')}</p>;
  const blocked = blockers.length > 0;
  return (
    <div className="flex flex-col gap-3">
      <div id="approve-blocked" aria-live="polite" className="text-sm text-fg-muted">
        {blockers.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          className="max-sm:w-full aria-disabled:cursor-not-allowed aria-disabled:bg-muted aria-disabled:text-fg-muted"
          aria-disabled={blocked ? true : undefined}
          aria-describedby={blocked ? 'approve-blocked' : undefined}
          onClick={() => {
            if (!blocked) setOpen('approve');
          }}
        >
          {t('approve')}
        </Button>
        <Button
          variant="secondary"
          className="max-sm:w-full"
          onClick={() => setOpen('request-changes')}
        >
          {t('request-changes')}
        </Button>
        <Button variant="secondary" className="max-sm:w-full" onClick={() => setOpen('decline')}>
          {t('decline')}
        </Button>
      </div>
      {open === null ? null : (
        <DecisionDialog
          kind={open}
          certificateId={certificateId}
          submissionId={submissionId}
          csrfToken={csrfToken}
          version={version}
          reasons={
            open === 'request-changes'
              ? (reasons['changes-requested'] ?? [])
              : open === 'decline'
                ? (reasons.declined ?? [])
                : []
          }
          onClose={() => setOpen(null)}
          store={store}
          typeName={typeName}
          submissionNo={submissionNo}
          renewal={renewal}
        />
      )}
    </div>
  );
}

function DecisionDialog({
  kind,
  certificateId,
  submissionId,
  csrfToken,
  version,
  reasons,
  onClose,
  store,
  typeName,
  submissionNo,
  renewal,
}: Common & {
  readonly kind: Decision;
  readonly version: number;
  readonly reasons: readonly ReviewReason[];
  readonly onClose: () => void;
  readonly store: string;
  readonly typeName: string;
  readonly submissionNo: number;
  readonly renewal: boolean;
}) {
  const t = useTranslations('certificates.review.decision');
  const tr = useTranslations();
  const formId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const call = useReviewCall(csrfToken);
  const [reasonCode, setReasonCode] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [checked, setChecked] = useState(false);
  const needsReason = kind !== 'approve';
  const chosen = reasons.find((reason) => reason.code === reasonCode);
  const reasonError =
    checked && needsReason && reasonCode === '' ? t('reason-required') : undefined;
  const textError =
    reasonText.length > REASON_TEXT_MAX ? t('text-long', { max: REASON_TEXT_MAX }) : undefined;
  // Typed text is never lost to a stray click or Escape; Cancel is the way out.
  const dirty = reasonCode !== '' || reasonText !== '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if ((needsReason && reasonCode === '') || textError !== undefined) return;
    const body: Record<string, unknown> = { submissionId, version };
    if (needsReason) {
      body.reasonCode = reasonCode;
      if (reasonText.trim() !== '') body.reasonText = reasonText.trim();
    }
    const answer = await call.run(`${API_CERTIFICATES}/${certificateId}/${kind}`, body);
    if (answer.ok) window.location.assign(`/certificates?decided=${kind}`);
  }

  return (
    <Dialog
      open
      title={t(`title.${kind}`, { n: submissionNo })}
      onClose={() => {
        if (!dirty && !call.pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        <>
          <Button variant="secondary" ref={cancel} disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {call.problem?.reload === true ? (
            <Button onClick={() => window.location.reload()}>{t('reload')}</Button>
          ) : (
            <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
              {t(`confirm.${kind}`)}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        noValidate
        className="flex flex-col gap-4"
      >
        <div role="alert">
          {call.problem === null ? null : (
            <Banner tone="critical">{tr(call.problem.key as never)}</Banner>
          )}
        </div>
        <p className="text-sm">
          {t(`body.${kind === 'approve' && renewal ? 'approve-renewal' : kind}`, {
            store,
            type: typeName,
          })}
        </p>
        {needsReason ? (
          <>
            {reasons.length === 0 ? (
              <Banner tone="attention">{t('no-reasons')}</Banner>
            ) : (
              <>
                <Select
                  label={t('reason')}
                  required
                  placeholder={t('reason-placeholder')}
                  value={reasonCode}
                  onChange={(event) => setReasonCode(event.target.value)}
                  options={reasons.map((reason) => ({
                    value: reason.code,
                    label: wordsFor(tr, 'reason', reason.code),
                  }))}
                  error={reasonError}
                />
                {chosen === undefined ? null : (
                  <p className="text-sm text-fg-muted">
                    {t('next-step', { step: wordsFor(tr, 'next-step', chosen.nextStep) })}
                  </p>
                )}
              </>
            )}
            <TextAreaField
              label={t('note')}
              optionalLabel={t('optional')}
              rows={3}
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              help={t('note-help')}
              error={textError}
            />
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
