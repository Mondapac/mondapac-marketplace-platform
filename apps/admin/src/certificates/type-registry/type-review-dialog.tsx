'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import type { TypeProblem } from './errors.ts';
import { ImpactLine, useImpactCount } from './impact-count.tsx';
import { TEXT_ARTWORK, type RulesDraft } from './type-fields.tsx';

export interface NewTypeSummary {
  readonly code: string;
  readonly mode: string;
  readonly rules: RulesDraft;
  readonly termsByLocale: Readonly<Record<string, readonly string[]>>;
}

/** The one-line summary of a type's settings, shared by the review dialog and the proposed page. */
export function useSettingsLine() {
  const t = useTranslations('certificates.types.review');
  const tm = useTranslations('certificates.types.mode');
  const tb = useTranslations('certificates.types.basis');
  return (value: {
    readonly mode: string;
    readonly issuer: boolean;
    readonly document: boolean;
    readonly expiry: boolean;
    readonly basis: string;
    readonly icon: string;
  }) => {
    const needs = [
      value.issuer ? t('needs-issuer') : null,
      value.document ? t('needs-document') : null,
      value.expiry ? t('needs-expiry') : null,
    ].filter((part) => part !== null);
    return [
      tm.has(value.mode as never) ? tm(value.mode as never) : value.mode,
      needs.length === 0 ? t('needs-nothing') : t('needs', { list: needs.join(', ') }),
      t('default', {
        basis: tb.has(value.basis as never) ? tb(value.basis as never) : value.basis,
      }),
      value.icon === TEXT_ARTWORK ? t('text-badge') : value.icon,
    ].join(' · ');
  };
}

/**
 * The last look before a new type is sent: the settings, the claim terms, how many published
 * texts they will match, and that a second admin decides. A failed count never blocks the send.
 */
export function TypeReviewDialog({
  summary,
  csrfToken,
  pending,
  problem,
  onBack,
  onSend,
}: {
  readonly summary: NewTypeSummary;
  readonly csrfToken: string;
  readonly pending: boolean;
  readonly problem: TypeProblem | null;
  readonly onBack: () => void;
  readonly onSend: () => void;
}) {
  const t = useTranslations('certificates.types.review');
  const tr = useTranslations();
  const back = useRef<HTMLButtonElement>(null);
  const line = useSettingsLine();
  const impact = useImpactCount(csrfToken, summary.code, summary.termsByLocale);
  return (
    <Dialog
      open
      title={t('title')}
      onClose={() => {
        if (!pending) onBack();
      }}
      initialFocus={back}
      actions={
        <>
          <Button ref={back} variant="secondary" disabled={pending} onClick={onBack}>
            {t('back')}
          </Button>
          <Button loading={pending} disabled={pending} onClick={onSend}>
            {t('send')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div aria-live="polite" className="flex flex-col gap-2">
          {problem === null ? null : <Banner tone="critical">{tr(problem.key)}</Banner>}
          {problem === null || problem.issues.length === 0 ? null : (
            <ul className="list-disc ps-5 text-sm">
              {problem.issues.map((key) => (
                <li key={key}>{tr(`certificates.types.revise.issue.${key}` as never)}</li>
              ))}
            </ul>
          )}
        </div>
        <p className="font-medium wrap-anywhere">
          <span dir="ltr">{summary.code}</span>
          {' · '}
          {line({
            mode: summary.mode,
            issuer: summary.rules.requiresIssuerRegistry,
            document: summary.rules.requiresDocument,
            expiry: summary.rules.requiresExpiry,
            basis: summary.rules.defaultBasis,
            icon: summary.rules.icon,
          })}
        </p>
        {Object.entries(summary.termsByLocale).map(([locale, terms]) => (
          <p key={locale} className="text-sm wrap-anywhere">
            {t('terms', { locale })}{' '}
            <span lang={locale} dir="auto">
              {terms.length === 0 ? t('terms-none') : terms.join(', ')}
            </span>
          </p>
        ))}
        <ImpactLine state={impact} context="send" />
        <Banner tone="info">{t('second-admin')}</Banner>
      </div>
    </Dialog>
  );
}
