'use client';

import { Banner, Button, Dialog, Select, TextAreaField, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import {
  API_SUGGESTIONS,
  directionOf,
  languageName,
  textIn,
  type SuggestionDecided,
  type SuggestionItem,
} from './types.ts';

export type ValueDecision = 'approve' | 'map' | 'reject';

const LABEL_MAX = 120;
const REASON_MAX = 300;
const CODE_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Whether the words give a code by themselves (the API makes it from Latin letters and digits). */
const hasLatin = (text: string): boolean => /[a-z0-9]/i.test(text.normalize('NFKD'));

interface Problem {
  readonly key: string;
  readonly reload: boolean;
}

/** A message key under `attributes.suggestions.error` for a refused decision. */
const BY_CODE: Readonly<Record<string, Problem>> = {
  'validation.failed': { key: 'invalid', reload: false },
  'attribute-definition.default-label-required': { key: 'invalid', reload: false },
  'suggestion.stale': { key: 'stale', reload: true },
  'suggestion.not-open': { key: 'stale', reload: true },
  'suggestion.not-found': { key: 'stale', reload: true },
  'suggestion.attribute-unavailable': { key: 'attribute-unavailable', reload: true },
  'suggestion.attribute-protected': { key: 'attribute-unavailable', reload: true },
  'suggestion.label-invalid': { key: 'invalid', reload: false },
  'attribute-definition.not-published': { key: 'attribute-unavailable', reload: true },
  'attribute-definition.archived': { key: 'attribute-unavailable', reload: true },
  'attribute-definition.option-repeated': { key: 'value-exists', reload: false },
  'attribute.claim-word': { key: 'claim', reload: false },
  'attribute.locale-uncheckable': { key: 'locale-uncheckable', reload: false },
  'claim-text.check-unavailable': { key: 'check-unavailable', reload: false },
  'suggestion.option-invalid': { key: 'option-invalid', reload: true },
  'suggestion.reason-invalid': { key: 'invalid', reload: false },
  'access.denied': { key: 'denied', reload: false },
  'request.throttled': { key: 'throttled', reload: false },
  'request.csrf': { key: 'csrf', reload: false },
};

function problemOf(failure: ApiFailure): Problem {
  const known = BY_CODE[failure.code];
  if (known !== undefined) return known;
  return {
    key: failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown',
    reload: false,
  };
}

/**
 * The decision on one value suggestion, opened from the row's Actions menu (confirmation level 2:
 * it names the seller's words and what follows, the red button is not the focused one, approving
 * names the value in every required language, and a rejection needs the reason the seller reads in
 * an email). A refused decision is told in the dialog; one that went stale closes it and the list
 * reads again, with the reason said above the list.
 */
export function ValueSuggestionDialog({
  item,
  decision,
  requiredLocales,
  defaultLocale,
  supported,
  csrfToken,
  onClose,
  onSettled,
}: {
  readonly item: SuggestionItem | null;
  readonly decision: ValueDecision | null;
  readonly requiredLocales: readonly string[];
  readonly defaultLocale: string;
  readonly supported: readonly string[];
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The decision was made, or went stale (`why` is the error key to tell the admin). */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('attributes.suggestions');
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [optionCode, setOptionCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    setLabels(item === null ? {} : { [defaultLocale]: item.label });
    setOptionCode('');
    setNewCode('');
    setReason('');
    setProblem(null);
  }, [item, decision, defaultLocale]);

  if (item === null || decision === null) return null;
  const locales = requiredLocales.length === 0 ? [defaultLocale] : requiredLocales;
  const attributeName = textIn(
    item.attribute.names,
    defaultLocale,
    defaultLocale,
    item.attribute.code,
  );
  const codeNeeded = !hasLatin(labels[defaultLocale] ?? '');
  const codeBad = newCode !== '' && !CODE_RE.test(newCode);
  const ready =
    decision === 'approve'
      ? !codeBad &&
        !(codeNeeded && newCode === '') &&
        !locales.some((locale) => (labels[locale] ?? '').trim() === '')
      : decision === 'map'
        ? optionCode !== ''
        : reason.trim() !== '';

  async function submit() {
    if (busy.current || item === null || decision === null || !ready) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const sent: Record<string, string> = {};
    for (const locale of locales) sent[locale] = (labels[locale] ?? '').trim();
    const body =
      decision === 'approve'
        ? { labels: sent, ...(newCode === '' ? {} : { optionCode: newCode }) }
        : decision === 'map'
          ? { optionCode }
          : { reason: reason.trim() };
    const result = await callApi<SuggestionDecided>(
      'POST',
      `${API_SUGGESTIONS}/${item.id}/${decision}`,
      { version: item.version, ...body },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(`decided.${result.body.suggestion.status}`));
      onSettled();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = problemOf(result.failure);
    if (next.reload) onSettled(next.key);
    else setProblem(next);
  }

  return (
    <Dialog
      open
      size="form"
      title={t(`dialog.${decision}.title`, { label: item.label })}
      onClose={() => {
        if (!pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive-solid"
            loading={pending}
            disabled={!ready || pending}
            onClick={() => void submit()}
          >
            {t(`${decision}-confirm`)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="wrap-anywhere">
          {t(`dialog.${decision}.body`, { label: item.label, attribute: attributeName })}
        </p>
        {problem === null ? null : (
          <div role="alert">
            <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>
          </div>
        )}
        {decision === 'approve' ? (
          <>
            <p className="text-sm text-fg-muted">{t('approve-note')}</p>
            {locales.map((locale) => (
              <TextField
                key={locale}
                name={`label-${locale}`}
                label={t('name-in', { language: languageName(locale, supported) })}
                value={labels[locale] ?? ''}
                maxLength={LABEL_MAX}
                lang={locale}
                dir={directionOf(locale)}
                autoComplete="off"
                onChange={(event) => setLabels({ ...labels, [locale]: event.target.value })}
              />
            ))}
            <TextField
              name="option-code"
              label={t('value-code')}
              help={codeNeeded ? t('value-code-needed') : t('value-code-help')}
              value={newCode}
              maxLength={63}
              dir="ltr"
              autoComplete="off"
              error={codeBad ? t('value-code-bad') : undefined}
              onChange={(event) => setNewCode(event.target.value.trim().toLowerCase())}
            />
          </>
        ) : null}
        {decision === 'map' ? (
          <Select
            label={t('map-to')}
            placeholder={t('map-choose')}
            value={optionCode}
            options={item.attribute.options.map((option) => ({
              value: option.code,
              label: textIn(option.labels, defaultLocale, defaultLocale, option.code),
            }))}
            onChange={(event) => setOptionCode(event.target.value)}
          />
        ) : null}
        {decision === 'reject' ? (
          <TextAreaField
            name="reason"
            label={t('reason')}
            help={t('reason-help')}
            rows={3}
            value={reason}
            maxLength={REASON_MAX}
            dir="auto"
            counter={`${reason.length} / ${REASON_MAX}`}
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
