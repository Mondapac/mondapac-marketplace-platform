'use client';

import { Banner, Button, RadioGroup, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { API_REQUESTS, type RequestDetail } from './types.ts';
import { useRequestCall } from './use-request-call.ts';

/** The few fields the answer needs: the rest of the request is not sent to the browser for it. */
export type AnswerableRequest = Pick<
  RequestDetail,
  'issuerRequestId' | 'version' | 'activeIssuers' | 'reasons'
>;

/**
 * Answer an open request: "Issuer added" (one of the active issuers of the type, created in the
 * registry first) or "Not accepted" (a prepared reason). Nothing is preselected; the answer names
 * the request version read.
 */
export function AnswerForm({
  request,
  csrfToken,
}: {
  readonly request: AnswerableRequest;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.requests.answer');
  const tr = useTranslations();
  const call = useRequestCall(csrfToken);
  const [outcome, setOutcome] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [checked, setChecked] = useState(false);
  const noIssuers = request.activeIssuers.length === 0;
  const noReasons = request.reasons.length === 0;

  const outcomeError = checked && outcome === '' ? t('outcome-required') : undefined;
  const issuerError =
    checked && outcome === 'issuer-added' && issuerId === '' ? t('issuer-required') : undefined;
  const reasonError =
    checked && outcome === 'not-accepted' && reasonCode === '' ? t('reason-required') : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (outcome === '') return;
    if (outcome === 'issuer-added' && issuerId === '') return;
    if (outcome === 'not-accepted' && reasonCode === '') return;
    const body =
      outcome === 'issuer-added'
        ? { version: request.version, outcome, issuerId }
        : { version: request.version, outcome, reasonCode };
    const answer = await call.run(`${API_REQUESTS}/${request.issuerRequestId}/answer`, body);
    if (answer.ok) window.location.assign('/certificates/issuer-requests?answered=1');
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
      <div role="alert">
        {call.problem === null ? null : (
          <Banner tone="critical">{tr(call.problem.key as never)}</Banner>
        )}
      </div>
      <RadioGroup
        legend={t('legend')}
        name="outcome"
        value={outcome}
        onChange={setOutcome}
        disabled={call.pending}
        options={[
          {
            value: 'issuer-added',
            label: t('issuer-added'),
            help: noIssuers ? t('no-issuers') : t('issuer-added-help'),
            disabled: noIssuers,
          },
          {
            value: 'not-accepted',
            label: t('not-accepted'),
            help: noReasons ? t('no-reasons') : t('not-accepted-help'),
            disabled: noReasons,
          },
        ]}
        note={outcomeError === undefined ? undefined : <span role="alert">{outcomeError}</span>}
      />
      {noIssuers ? (
        <p className="text-sm">
          <a className="font-medium text-link underline" href="/certificates/issuers">
            {t('open-registry')}
          </a>
        </p>
      ) : null}
      {outcome === 'issuer-added' ? (
        <Select
          label={t('issuer')}
          required
          placeholder={t('issuer-placeholder')}
          value={issuerId}
          onChange={(event) => setIssuerId(event.target.value)}
          options={request.activeIssuers.map((issuer) => ({
            value: issuer.issuerId,
            label: issuer.displayName,
          }))}
          error={issuerError}
        />
      ) : null}
      {outcome === 'not-accepted' ? (
        <Select
          label={t('reason')}
          required
          placeholder={t('reason-placeholder')}
          value={reasonCode}
          onChange={(event) => setReasonCode(event.target.value)}
          options={request.reasons.map((reason) => ({ value: reason.code, label: reason.label }))}
          error={reasonError}
        />
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        {call.problem?.reload === true ? (
          <Button className="max-sm:w-full" onClick={() => window.location.reload()}>
            {t('reload')}
          </Button>
        ) : (
          <Button
            type="submit"
            className="max-sm:w-full"
            loading={call.pending}
            disabled={call.pending}
          >
            {t('submit')}
          </Button>
        )}
      </div>
    </form>
  );
}
