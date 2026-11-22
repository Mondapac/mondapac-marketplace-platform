'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { ImpactLine, useImpactCount } from './impact-count.tsx';
import { API_TYPES, type TypeContent, type TypeProposal } from './types.ts';
import { useTypeCall } from './use-type-call.ts';

type Answer = 'approve' | 'reject' | 'withdraw';

/** The server's code for "approve is closed because nobody else could": shown as its own message. */
const NO_OTHER_ADMIN = 'review.no-other-admin';

/** A date in UTC, as the design shows it ("22 Nov 2026 (UTC)"). */
function utcDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/**
 * A proposed new type: who proposed it and why, the count of texts its claim terms will match, and
 * what this admin may do. The proposer may withdraw and change it but not approve or reject; any
 * other admin with the edit permission may approve or reject. The server decides again on each call.
 */
export function TypeCreationCard({
  typeId,
  proposal,
  content,
  code,
  accountId,
  canEdit,
  hasActiveIssuer,
  csrfToken,
}: {
  readonly typeId: string;
  readonly proposal: TypeProposal;
  readonly content: TypeContent;
  readonly code: string;
  readonly accountId: string;
  readonly canEdit: boolean;
  /** Whether an issuer of this type is active; null when the read failed. */
  readonly hasActiveIssuer: boolean | null;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.types.creation');
  const tr = useTranslations();
  const locale = useLocale();
  const call = useTypeCall(csrfToken);
  const cancel = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<Answer | null>(null);
  const { approve, reject, withdraw } = proposal.actions;
  const proposer =
    proposal.proposer?.accountId === accountId || approve.code === 'review.second-admin-required';
  const termsByLocale = Object.fromEntries(
    Object.entries(content.locales ?? {}).map(([name, text]) => [name, text.claimTerms ?? []]),
  );
  const impact = useImpactCount(csrfToken, code, termsByLocale);

  async function answer(which: Answer) {
    const path =
      which === 'approve'
        ? `creations/${proposal.id}/approve`
        : `proposals/${proposal.id}/${which}`;
    const result = await call.run<unknown>(`${API_TYPES}/${typeId}/${path}`, {
      version: proposal.version,
    });
    if (result.ok) {
      const what =
        which === 'approve'
          ? 'type-approved'
          : which === 'reject'
            ? 'type-rejected'
            : 'type-withdrawn';
      window.location.assign(`/certificates/types/${typeId}?done=${what}`);
    }
  }

  const reason =
    proposal.reason?.state === 'given' && proposal.reason.text !== undefined
      ? proposal.reason.text
      : null;
  const mayWithdraw = canEdit && (withdraw.allowed || proposer);
  const mayAnswer = canEdit && !proposer;
  return (
    <section
      aria-labelledby="creation-title"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h3 id="creation-title" className="text-base font-semibold">
        {t('waiting')}
      </h3>
      <p className="text-sm">{t('hidden')}</p>
      <p className="text-sm wrap-anywhere">
        {proposer ? t('proposed-by-you') : t('proposed-by-other')}{' '}
        {t('on', { date: utcDate(proposal.proposedAt, locale) })}
        {reason === null ? null : (
          <>
            {' · '}
            {t('reason')}: &ldquo;<span dir="auto">{reason}</span>&rdquo;
          </>
        )}
      </p>
      <ImpactLine state={impact} context="view" />
      {content.requiresIssuerRegistry === true && hasActiveIssuer === false ? (
        <Banner tone="attention">
          {t('no-issuer')}{' '}
          <a className="font-medium underline" href="/certificates/issuers">
            {t('add-issuer')}
          </a>
        </Banner>
      ) : null}
      {approve.code === NO_OTHER_ADMIN ? <Banner tone="info">{t('no-other-admin')}</Banner> : null}
      {canEdit ? (
        <>
          {proposer ? (
            <p id="creation-own" className="text-sm text-fg-muted">
              {t('own')}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              className="max-sm:w-full"
              disabled={!mayAnswer || !approve.allowed}
              aria-describedby={proposer ? 'creation-own' : undefined}
              onClick={() => setAsking('approve')}
            >
              {t('approve')}
            </Button>
            <Button
              variant="destructive"
              className="max-sm:w-full"
              disabled={!mayAnswer || !reject.allowed}
              aria-describedby={proposer ? 'creation-own' : undefined}
              onClick={() => setAsking('reject')}
            >
              {t('reject')}
            </Button>
            {mayWithdraw ? (
              <Button
                variant="destructive"
                className="max-sm:w-full"
                onClick={() => setAsking('withdraw')}
              >
                {t('withdraw')}
              </Button>
            ) : null}
            {proposer ? (
              <a
                className="inline-flex min-h-(--mp-size-control) items-center justify-center font-medium text-link underline"
                href={`/certificates/types/${typeId}/edit`}
              >
                {t('change')}
              </a>
            ) : null}
          </div>
        </>
      ) : null}
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
          <div className="flex flex-col gap-3">
            <div aria-live="polite">
              {call.problem === null ? null : (
                <Banner tone="critical">{tr(call.problem.key)}</Banner>
              )}
            </div>
            <p>{t(`confirm.${asking}.body`)}</p>
          </div>
        </Dialog>
      )}
    </section>
  );
}
