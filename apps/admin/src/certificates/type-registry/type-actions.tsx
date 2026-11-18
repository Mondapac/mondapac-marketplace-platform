'use client';

import { Banner, Button, Dialog, TextAreaField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { When } from '../../shared/when.tsx';
import {
  API_TYPES,
  REASON_MAX,
  type DiffEntry,
  type ProposalKind,
  type TypeProposal,
} from './types.ts';
import { useTypeCall } from './use-type-call.ts';

/** Where the page goes after a change, with a notice for what happened. */
const done = (typeId: string, what: string) =>
  window.location.assign(`/certificates/types/${typeId}?done=${what}`);

/** A confirm dialog: Cancel first, the refusal in words, a reload when the type moved on. */
function ConfirmDialog({
  title,
  confirmLabel,
  tone,
  pending,
  reload,
  problem,
  onSubmit,
  onClose,
  children,
}: {
  readonly title: string;
  readonly confirmLabel: string;
  readonly tone: 'primary' | 'destructive-solid';
  readonly pending: boolean;
  readonly reload: boolean;
  readonly problem: string | null;
  readonly onSubmit: () => Promise<void>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useTranslations('certificates.types.dialog');
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
      onClose={onClose}
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
            <Button type="submit" form={formId} variant={tone} loading={pending} disabled={pending}>
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

/**
 * What an admin who may edit types can do on the page of one type: stop new certificates of an
 * active type, or ask for an inactive one to be reactivated (a second admin decides).
 */
export function TypeActions({
  typeId,
  version,
  status,
  name,
  reactivationWaiting,
  csrfToken,
}: {
  readonly typeId: string;
  readonly version: number;
  readonly status: 'active' | 'inactive';
  readonly name: string;
  readonly reactivationWaiting: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.types.actions');
  const [open, setOpen] = useState<'deactivate' | 'reactivate' | null>(null);
  return (
    <>
      {status === 'active' ? (
        <Button
          variant="destructive"
          className="max-sm:w-full"
          onClick={() => setOpen('deactivate')}
        >
          {t('deactivate')}
        </Button>
      ) : reactivationWaiting ? null : (
        <Button variant="secondary" className="max-sm:w-full" onClick={() => setOpen('reactivate')}>
          {t('reactivate')}
        </Button>
      )}
      {open === 'deactivate' ? (
        <DeactivateDialog
          typeId={typeId}
          version={version}
          name={name}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === 'reactivate' ? (
        <ReactivateDialog
          typeId={typeId}
          version={version}
          name={name}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

interface DialogProps {
  readonly typeId: string;
  readonly version: number;
  readonly name: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
}

function DeactivateDialog({ typeId, version, name, csrfToken, onClose }: DialogProps) {
  const t = useTranslations('certificates.types.deactivate');
  const tr = useTranslations();
  const call = useTypeCall(csrfToken);

  async function submit() {
    const answer = await call.run<unknown>(`${API_TYPES}/${typeId}/deactivate`, { version });
    if (answer.ok) done(typeId, 'deactivated');
  }

  return (
    <ConfirmDialog
      title={t('title')}
      confirmLabel={t('confirm')}
      tone="destructive-solid"
      pending={call.pending}
      reload={call.problem?.reload === true}
      problem={call.problem === null ? null : tr(call.problem.key)}
      onSubmit={submit}
      onClose={onClose}
    >
      <p>{t('body', { name })}</p>
    </ConfirmDialog>
  );
}

function ReactivateDialog({ typeId, version, name, csrfToken, onClose }: DialogProps) {
  const t = useTranslations('certificates.types.reactivate');
  const tr = useTranslations();
  const call = useTypeCall(csrfToken);
  const [reason, setReason] = useState('');
  const why = reason.trim();
  const error = why.length > REASON_MAX ? t('reason-long', { max: REASON_MAX }) : undefined;

  async function submit() {
    if (error !== undefined) return;
    const answer = await call.run<unknown>(`${API_TYPES}/${typeId}/reactivation`, {
      version,
      ...(why === '' ? {} : { reason: why }),
    });
    if (answer.ok) done(typeId, 'reactivation-asked');
  }

  return (
    <ConfirmDialog
      title={t('title')}
      confirmLabel={t('confirm')}
      tone="primary"
      pending={call.pending}
      reload={call.problem?.reload === true}
      problem={call.problem === null ? null : tr(call.problem.key)}
      onSubmit={submit}
      onClose={onClose}
    >
      <Banner tone="attention">{t('note', { name })}</Banner>
      <TextAreaField
        label={t('reason')}
        optionalLabel={t('optional')}
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        help={t('reason-help', { max: REASON_MAX })}
        error={error}
      />
    </ConfirmDialog>
  );
}

type Answer = 'approve' | 'reject' | 'withdraw';

const SETTING_LABELS: Readonly<Record<string, string>> = {
  verificationMode: 'mode',
  requiresIssuerRegistry: 'needs-issuer',
  requiresDocument: 'needs-document',
  requiresExpiry: 'needs-expiry',
  defaultBasis: 'default-basis',
  autoApproveSelfDeclaration: 'auto-approve',
  badgeIconKey: 'icon',
};

/** A value of the diff: a switch in words, a known code in words, anything else as the text it is. */
function Value({
  path,
  value,
}: {
  readonly path: string;
  readonly value: string | boolean | null;
}) {
  const t = useTranslations('certificates.types.proposal');
  const basis = useTranslations('certificates.types.basis');
  const mode = useTranslations('certificates.types.mode');
  if (value === null) return <span className="text-fg-muted">{t('empty')}</span>;
  if (typeof value === 'boolean') return <>{t(value ? 'on' : 'off')}</>;
  const words = path === 'defaultBasis' ? basis : path === 'verificationMode' ? mode : null;
  return (
    <span className="wrap-anywhere">
      {words?.has(value as never) === true ? words(value as never) : value}
    </span>
  );
}

function DiffList({ diff }: { readonly diff: readonly DiffEntry[] }) {
  const t = useTranslations('certificates.types.proposal');
  const detail = useTranslations('certificates.types.detail');
  const label = (path: string) => {
    const known = Object.hasOwn(SETTING_LABELS, path) ? SETTING_LABELS[path] : undefined;
    if (known !== undefined) return detail(known as never);
    return path.startsWith('row:') ? t('policy-row') : path;
  };
  if (diff.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {diff.map((entry) => (
        <li key={entry.path} className="rounded-md border border-line p-2">
          <p className="font-medium wrap-anywhere">{label(entry.path)}</p>
          <p>
            <span className="text-fg-muted">{t('before')}: </span>
            <Value path={entry.path} value={entry.before} />
          </p>
          <p>
            <span className="text-fg-muted">{t('after')}: </span>
            <Value path={entry.path} value={entry.after} />
          </p>
          {entry.relaxes ? <p className="text-fg-muted">{t('relaxes')}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A change that waits for a second admin: a type revision that relaxes a setting, or a
 * reactivation. Which answers are open comes from the API (`actions`); each is confirmed in a
 * dialog. Text from an admin (the reason) is shown as plain text.
 */
export function TypeProposalCard({
  typeId,
  kind,
  proposal,
  csrfToken,
}: {
  readonly typeId: string;
  readonly kind: ProposalKind;
  readonly proposal: TypeProposal;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.types.proposal');
  const tr = useTranslations();
  const call = useTypeCall(csrfToken);
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<Answer | null>(null);

  async function answer(which: Answer) {
    const path =
      which === 'approve'
        ? `${kind === 'revision' ? 'relaxations' : 'reactivations'}/${proposal.id}/approve`
        : `proposals/${proposal.id}/${which}`;
    const result = await call.run<unknown>(`${API_TYPES}/${typeId}/${path}`, {
      version: proposal.version,
    });
    if (result.ok) {
      done(
        typeId,
        which === 'approve' ? 'approved' : which === 'reject' ? 'rejected' : 'withdrawn',
      );
    }
  }

  const { approve, reject, withdraw } = proposal.actions;
  const buttons: readonly [Answer, boolean, 'primary' | 'secondary'][] = [
    ['approve', approve.allowed, 'primary'],
    ['reject', reject.allowed, 'secondary'],
    ['withdraw', withdraw.allowed, 'secondary'],
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
        {t(`title.${kind}`)}
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
      ) : proposal.reason?.state === 'erased' ? (
        <p className="text-fg-muted">{t('reason-erased')}</p>
      ) : null}
      <DiffList diff={proposal.diff} />
      {note === null ? null : <p className="text-fg-muted">{note}</p>}
      <div className="flex flex-wrap gap-2">
        {open.map(([which, , variant]) => (
          <Button
            key={which}
            variant={variant}
            className="max-sm:w-full"
            onClick={() => setAsking(which)}
          >
            {t(which)}
          </Button>
        ))}
      </div>
      {asking === null ? null : (
        <Dialog
          open
          title={t(`confirm.${asking}.title`)}
          onClose={() => setAsking(null)}
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
          <p>{t(`confirm.${asking}.body.${kind}`)}</p>
        </Dialog>
      )}
    </section>
  );
}
