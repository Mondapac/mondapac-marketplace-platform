'use client';

import { Banner, Button, Dialog, TextAreaField, TextField } from '@mondapac/ui';
import { When } from '../../shared/when.tsx';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  API_ISSUERS,
  CONFIRMED_BY_MAX,
  REASON_MAX,
  REFERENCE_MAX,
  type ExpertReference,
  type ExpertReferenceView,
  type IssuerDetail,
  type Proposal,
} from './types.ts';
import { useIssuerCall } from './use-issuer-call.ts';

export type LifecycleIssuer = Pick<
  IssuerDetail,
  'issuerId' | 'version' | 'displayName' | 'state' | 'affectedCertificates'
>;

/** Where the page goes after a change, with a notice for the new state. */
const done = (issuerId: string, what: string) =>
  window.location.assign(`/certificates/issuers/${issuerId}?done=${what}`);

/** The shell of the lifecycle forms: Cancel first, and a reload when the state moved on. */
function FormDialog({
  title,
  confirmLabel,
  confirmTone,
  pending,
  reload,
  problem,
  onSubmit,
  onClose,
  children,
}: {
  readonly title: string;
  readonly confirmLabel: string;
  readonly confirmTone: 'primary' | 'destructive-solid';
  readonly pending: boolean;
  readonly reload: boolean;
  readonly problem: string | null;
  readonly onSubmit: () => Promise<void>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useTranslations('certificates.issuers.close');
  const formId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    void onSubmit();
  }
  return (
    <Dialog
      open
      title={title}
      onClose={() => {
        if (!pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {reload ? (
            <Button type="button" autoFocus onClick={() => window.location.reload()}>
              {t('reload')}
            </Button>
          ) : (
            <Button
              type="submit"
              form={formId}
              variant={confirmTone}
              loading={pending}
              disabled={pending}
            >
              {confirmLabel}
            </Button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div aria-live="polite">
          {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
        </div>
        {children}
      </form>
    </Dialog>
  );
}

/** Form 1 of the two ways to take an issuer out of use: no new certificates, old ones stay. */
export function CloseToNewDialog({
  issuer,
  csrfToken,
  onClose,
}: {
  readonly issuer: LifecycleIssuer;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('certificates.issuers.close');
  const tr = useTranslations();
  const call = useIssuerCall(csrfToken);

  async function submit() {
    const answer = await call.run<unknown>(
      'POST',
      `${API_ISSUERS}/${issuer.issuerId}/close-to-new`,
      { version: issuer.version },
    );
    if (answer.ok) done(issuer.issuerId, 'closed');
  }

  return (
    <FormDialog
      title={t('title')}
      confirmLabel={t('confirm')}
      confirmTone="primary"
      pending={call.pending}
      reload={call.problem?.reload === true}
      problem={call.problem === null ? null : tr(call.problem.key)}
      onSubmit={submit}
      onClose={onClose}
    >
      <p>{t('body', { name: issuer.displayName })}</p>
      <p className="text-fg-muted">{t('affected', { count: issuer.affectedCertificates })}</p>
    </FormDialog>
  );
}

/** Form 2: derecognise. The admin types the number of affected certificates the form showed. */
export function DerecogniseDialog({
  issuer,
  csrfToken,
  onClose,
}: {
  readonly issuer: LifecycleIssuer;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('certificates.issuers.derecognise');
  const tr = useTranslations();
  const call = useIssuerCall(csrfToken);
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const count = issuer.affectedCertificates;
  const matches = typed.trim() === String(count);

  async function submit() {
    setChecked(true);
    if (!matches) return;
    const answer = await call.run<unknown>(
      'POST',
      `${API_ISSUERS}/${issuer.issuerId}/derecognise`,
      { version: issuer.version, affectedCertificates: count },
    );
    if (answer.ok) done(issuer.issuerId, 'derecognised');
  }

  return (
    <FormDialog
      title={t('title')}
      confirmLabel={t('confirm')}
      confirmTone="destructive-solid"
      pending={call.pending}
      reload={call.problem?.reload === true}
      problem={call.problem === null ? null : tr(call.problem.key)}
      onSubmit={submit}
      onClose={onClose}
    >
      <Banner tone="critical">{t('warning', { name: issuer.displayName })}</Banner>
      <p className="font-medium">{t('affected', { count })}</p>
      <TextField
        label={t('confirm-label', { count })}
        required
        inputMode="numeric"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        help={t('confirm-help')}
        error={checked && !matches ? t('confirm-wrong') : undefined}
        autoComplete="off"
      />
    </FormDialog>
  );
}

/** Ask for a closed issuer to be activated again: a new expert approval, a second admin decides. */
export function ReactivateDialog({
  issuer,
  csrfToken,
  onClose,
}: {
  readonly issuer: LifecycleIssuer;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('certificates.issuers.reactivate');
  const tr = useTranslations();
  const call = useIssuerCall(csrfToken);
  const [by, setBy] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const b = by.trim();
  const r = reference.trim();
  const why = reason.trim();
  const byError =
    checked && b === '' ? t('by-required') : b.length > CONFIRMED_BY_MAX ? t('by-long') : undefined;
  const refError =
    checked && r === ''
      ? t('reference-required')
      : r.length > REFERENCE_MAX
        ? t('reference-long')
        : undefined;
  const reasonError = why.length > REASON_MAX ? t('reason-long') : undefined;

  async function submit() {
    setChecked(true);
    if (b === '' || r === '' || b.length > CONFIRMED_BY_MAX || r.length > REFERENCE_MAX) return;
    if (why.length > REASON_MAX) return;
    const answer = await call.run<unknown>(
      'POST',
      `${API_ISSUERS}/${issuer.issuerId}/reactivation`,
      {
        version: issuer.version,
        expertApproval: { confirmedBy: b, reference: r },
        ...(why === '' ? {} : { reason: why }),
      },
    );
    if (answer.ok) done(issuer.issuerId, 'reactivation-asked');
  }

  return (
    <FormDialog
      title={t('title')}
      confirmLabel={t('confirm')}
      confirmTone="primary"
      pending={call.pending}
      reload={call.problem?.reload === true}
      problem={call.problem === null ? null : tr(call.problem.key)}
      onSubmit={submit}
      onClose={onClose}
    >
      <Banner tone="attention">{t('note')}</Banner>
      <TextField
        label={t('by')}
        required
        value={by}
        onChange={(event) => setBy(event.target.value)}
        help={t('by-help')}
        error={byError}
        autoComplete="off"
      />
      <TextField
        label={t('reference')}
        required
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        help={t('reference-help')}
        error={refError}
        autoComplete="off"
      />
      <TextAreaField
        label={t('reason')}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        help={t('reason-help')}
        error={reasonError}
      />
    </FormDialog>
  );
}

/**
 * The new expert approval a reactivation names, so the second admin sees what they approve. The
 * read needs the edit permission and the API records each one; nothing is read until View.
 */
function NewExpertApproval({
  issuerId,
  proposalId,
  csrfToken,
}: {
  readonly issuerId: string;
  readonly proposalId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.issuers.proposal.expert');
  const tr = useTranslations();
  const call = useIssuerCall(csrfToken);
  const [shown, setShown] = useState<ExpertReference | 'none' | null>(null);

  async function view() {
    const answer = await call.run<ExpertReferenceView>(
      'GET',
      `${API_ISSUERS}/${issuerId}/expert-reference`,
    );
    if (!answer.ok) return;
    const pending = answer.body.pendingReactivation;
    setShown(
      pending != null && pending.proposalId === proposalId ? pending.expertApproval : 'none',
    );
  }

  if (shown === 'none') return <p className="text-fg-muted">{t('not-found')}</p>;
  if (shown !== null) {
    return (
      <dl className="text-sm">
        <dt className="text-fg-muted">{t('confirmed-by')}</dt>
        <dd className="wrap-anywhere">{shown.confirmedBy}</dd>
        <dt className="mt-1 text-fg-muted">{t('reference')}</dt>
        <dd className="wrap-anywhere">{shown.reference}</dd>
        <dd className="mt-1 text-fg-muted">{t('audited')}</dd>
      </dl>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {call.problem === null ? null : <Banner tone="critical">{tr(call.problem.key)}</Banner>}
      <Button
        variant="secondary"
        className="max-sm:w-full"
        loading={call.pending}
        disabled={call.pending}
        onClick={() => void view()}
      >
        {t('view')}
      </Button>
    </div>
  );
}

type Answer = 'approve' | 'reject' | 'withdraw';

/**
 * The reactivation waiting for a second admin. Which answers are open comes from the API
 * (`actions`); a closed one is left out. Each answer is confirmed in a dialog, because approving
 * makes the issuer selectable at once and the others close the proposal for good.
 */
export function ProposalCard({
  issuerId,
  proposal,
  csrfToken,
}: {
  readonly issuerId: string;
  readonly proposal: Proposal;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.issuers.proposal');
  const tr = useTranslations();
  const call = useIssuerCall(csrfToken);
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<Answer | null>(null);

  async function answer(kind: Answer) {
    const path =
      kind === 'approve'
        ? `reactivations/${proposal.id}/approve`
        : `proposals/${proposal.id}/${kind}`;
    const result = await call.run<unknown>('POST', `${API_ISSUERS}/${issuerId}/${path}`, {
      version: proposal.version,
    });
    if (result.ok) {
      done(
        issuerId,
        kind === 'approve' ? 'approved' : kind === 'reject' ? 'rejected' : 'withdrawn',
      );
    }
  }

  const { approve, reject, withdraw } = proposal.actions;
  const buttons: readonly [Answer, boolean, 'primary' | 'secondary' | 'destructive'][] = [
    ['approve', approve.allowed, 'primary'],
    ['reject', reject.allowed, 'destructive'],
    ['withdraw', withdraw.allowed, 'destructive'],
  ];
  const open = buttons.filter(([, allowed]) => allowed);
  const note = approve.allowed
    ? null
    : withdraw.allowed
      ? t('second-admin')
      : open.length === 0
        ? t('no-actions')
        : null;
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h3 id={titleId} className="text-base font-semibold">
        {t('title')}
      </h3>
      <p>
        <span className="text-fg-muted">{t('sent')}: </span>
        <When iso={proposal.proposedAt} missing="-" />
      </p>
      {proposal.reason?.state === 'given' && proposal.reason.text !== undefined ? (
        <p className="wrap-anywhere">
          <span className="text-fg-muted">{t('reason')}: </span>
          {proposal.reason.text}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="text-fg-muted">{t('expert.title')}</span>
        <NewExpertApproval issuerId={issuerId} proposalId={proposal.id} csrfToken={csrfToken} />
      </div>
      {note === null ? null : <p className="text-fg-muted">{note}</p>}
      <div className="flex flex-wrap gap-2">
        {open.map(([kind, , variant]) => (
          <Button
            key={kind}
            variant={variant}
            className="max-sm:w-full"
            onClick={() => setAsking(kind)}
          >
            {t(kind)}
          </Button>
        ))}
      </div>
      {asking === null ? null : (
        <Dialog
          open
          title={t(`confirm.${asking}.title`)}
          onClose={() => {
            if (!call.pending) setAsking(null);
          }}
          initialFocus={cancel}
          actions={
            <>
              <Button
                ref={cancel}
                variant="secondary"
                disabled={call.pending}
                onClick={() => setAsking(null)}
              >
                {t('cancel')}
              </Button>
              {call.problem?.reload === true ? (
                <Button autoFocus onClick={() => window.location.reload()}>
                  {t('reload')}
                </Button>
              ) : (
                <Button
                  variant={asking === 'approve' ? 'primary' : 'destructive-solid'}
                  loading={call.pending}
                  disabled={call.pending}
                  onClick={() => void answer(asking)}
                >
                  {t(`confirm.${asking}.button`)}
                </Button>
              )}
            </>
          }
        >
          <div aria-live="polite">
            {call.problem === null ? null : <Banner tone="critical">{tr(call.problem.key)}</Banner>}
          </div>
          <p>{t(`confirm.${asking}.body`)}</p>
        </Dialog>
      )}
    </section>
  );
}
