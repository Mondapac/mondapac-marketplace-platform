'use client';

import { Banner, Button, Dialog, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import {
  API_ISSUERS,
  CONFIRMED_BY_MAX,
  REFERENCE_MAX,
  type ExpertReferenceView,
  type IssuerDetail,
} from './types.ts';
import { useIssuerCall } from './use-issuer-call.ts';

/**
 * What an admin who may edit issuers can do on the page of one issuer. This slice: Activate a
 * Proposed issuer. The other actions of an issuer arrive with their own screens.
 */
export function IssuerActions({
  issuer,
  csrfToken,
}: {
  readonly issuer: IssuerDetail;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.issuers.activate');
  const [open, setOpen] = useState(false);
  if (issuer.state !== 'proposed') return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('button')}</Button>
      {open ? (
        <ActivateDialog issuer={issuer} csrfToken={csrfToken} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ActivateDialog({
  issuer,
  csrfToken,
  onClose,
}: {
  readonly issuer: IssuerDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('certificates.issuers.activate');
  const tr = useTranslations();
  const formId = useId();
  const [confirmedBy, setConfirmedBy] = useState('');
  const [reference, setReference] = useState('');
  const [checked, setChecked] = useState(false);
  const call = useIssuerCall(csrfToken);

  const by = confirmedBy.trim();
  const ref = reference.trim();
  const byError =
    checked && by === ''
      ? t('by-required')
      : by.length > CONFIRMED_BY_MAX
        ? t('by-long')
        : undefined;
  const refError =
    checked && ref === ''
      ? t('reference-required')
      : ref.length > REFERENCE_MAX
        ? t('reference-long')
        : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (by === '' || ref === '' || by.length > CONFIRMED_BY_MAX || ref.length > REFERENCE_MAX)
      return;
    const answer = await call.run<unknown>('POST', `${API_ISSUERS}/${issuer.issuerId}/activate`, {
      version: issuer.version,
      expertApproval: { confirmedBy: by, reference: ref },
    });
    if (answer.ok) window.location.reload();
  }

  return (
    <Dialog
      open
      title={t('title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {call.problem?.reload === true ? (
            <Button onClick={() => window.location.reload()}>{t('reload')}</Button>
          ) : (
            <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
              {t('confirm')}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        noValidate
      >
        <div aria-live="polite">
          {call.problem === null ? null : <Banner tone="critical">{tr(call.problem.key)}</Banner>}
        </div>
        <Banner tone="attention">{t('expert-note')}</Banner>
        <div>
          <p className="text-sm font-medium text-fg">{t('name-label')}</p>
          <p className="wrap-anywhere">{issuer.displayName}</p>
          <p className="text-sm text-fg-muted">{t('name-help')}</p>
        </div>
        <TextField
          label={t('by')}
          value={confirmedBy}
          onChange={(event) => setConfirmedBy(event.target.value)}
          help={t('by-help')}
          error={byError}
          autoComplete="off"
        />
        <TextField
          label={t('reference')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          help={t('reference-help')}
          error={refError}
          autoComplete="off"
        />
      </form>
    </Dialog>
  );
}

/**
 * The expert approval of an issuer. For a reader who may edit issuers a "View" button reads it
 * (the API records each read); otherwise only whether one is recorded is shown.
 */
export function ExpertApproval({
  issuerId,
  recorded,
  canView,
  csrfToken,
}: {
  readonly issuerId: string;
  readonly recorded: boolean;
  readonly canView: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.issuers.expert');
  const tr = useTranslations();
  const call = useIssuerCall(csrfToken);
  const [shown, setShown] = useState<ExpertReferenceView['current']>(null);
  const [read, setRead] = useState(false);

  async function view() {
    const answer = await call.run<ExpertReferenceView>(
      'GET',
      `${API_ISSUERS}/${issuerId}/expert-reference`,
    );
    if (answer.ok) {
      setShown(answer.body.current);
      setRead(true);
    }
  }

  if (!recorded) return <span className="text-fg-muted">{t('not-recorded')}</span>;
  return (
    <div className="flex flex-col gap-2">
      <span>{t('recorded')}</span>
      {read && shown !== null ? (
        <dl className="text-sm">
          <dt className="text-fg-muted">{t('confirmed-by')}</dt>
          <dd className="wrap-anywhere">{shown.confirmedBy}</dd>
          <dt className="mt-1 text-fg-muted">{t('reference')}</dt>
          <dd className="wrap-anywhere">{shown.reference}</dd>
          <dd className="mt-1 text-fg-muted">{t('audited')}</dd>
        </dl>
      ) : canView ? (
        <div className="flex flex-col items-start gap-2">
          {call.problem === null ? null : <Banner tone="critical">{tr(call.problem.key)}</Banner>}
          <Button
            variant="secondary"
            loading={call.pending}
            disabled={call.pending}
            onClick={() => void view()}
          >
            {t('view')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
