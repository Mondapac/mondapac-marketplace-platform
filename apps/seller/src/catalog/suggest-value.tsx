'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ValueSuggestion } from './types.ts';

const LABEL_MAX = 120;

/** A message key under `catalog.edit.attribute.suggest.error` for a refused suggestion. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'suggestion.label-invalid': 'invalid',
  'suggestion.already-open': 'already-open',
  'suggestion.limit-reached': 'limit',
  'attribute.not-suggestable': 'not-suggestable',
  'suggestion.value-exists': 'value-exists',
  'product.not-editable': 'not-editable',
  'product.not-found': 'not-found',
  'access.seller-not-approved': 'not-approved',
  'seller.not-eligible': 'not-eligible',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

/**
 * "Suggest a value" under a select or multi-select field (attributes A5): the seller asks for a
 * value the field does not offer. While a suggestion is open the field stays empty and a reviewer
 * decides it; a rejected one shows the reviewer's words. Everything the seller typed is plain text.
 */
export function SuggestValue({
  productId,
  attributeCode,
  suggestions,
  csrfToken,
  onSuggested,
}: {
  readonly productId: string;
  readonly attributeCode: string;
  readonly suggestions: readonly ValueSuggestion[];
  readonly csrfToken: string;
  /** A suggestion was saved: the product is read again. */
  readonly onSuggested: () => void;
}) {
  const t = useTranslations('catalog.edit.attribute.suggest');
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  // Opening the form moves focus to its field; cancelling returns it to the button.
  useEffect(() => {
    if (editing) {
      opened.current = true;
      root.current?.querySelector<HTMLElement>('input')?.focus();
    } else if (opened.current) {
      opened.current = false;
      root.current?.querySelector<HTMLElement>('button')?.focus();
    }
  }, [editing]);

  const mine = suggestions.filter((item) => item.attributeCode === attributeCode);
  const open = mine.find((item) => item.status === 'open');
  const decided = open === undefined ? mine.find((item) => item.status !== 'open') : undefined;

  async function send() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await callApi(
      'POST',
      `catalog/seller/products/${productId}/attribute-suggestions`,
      { attributeCode, label: label.trim() },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setEditing(false);
      setLabel('');
      onSuggested();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(
      BY_CODE[result.failure.code] ??
        (result.failure.status === 0 || result.failure.status >= 500 ? 'unreachable' : 'unknown'),
    );
  }

  if (open !== undefined) {
    return (
      <p
        role="status"
        className="text-sm text-fg-muted"
        data-testid={`suggestion-open-${attributeCode}`}
      >
        {t('open', { label: open.label })}
      </p>
    );
  }
  return (
    <div ref={root} className="flex flex-col gap-2">
      {decided === undefined ? null : (
        <Banner tone="info">
          {decided.status === 'rejected'
            ? decided.rejectReason === null || decided.rejectReason === ''
              ? t('rejected', { label: decided.label })
              : t('rejected-reason', { label: decided.label, reason: decided.rejectReason })
            : t(decided.status === 'approved' ? 'approved' : 'mapped', { label: decided.label })}
        </Banner>
      )}
      {editing ? (
        <div className="flex flex-col gap-2">
          {error === null ? null : <Banner tone="critical">{t(`error.${error}`)}</Banner>}
          <TextField
            name={`suggest.${attributeCode}`}
            label={t('label')}
            help={t('help')}
            value={label}
            maxLength={LABEL_MAX}
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              loading={pending}
              disabled={pending || label.trim() === ''}
              onClick={() => void send()}
            >
              {t('send')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
            {t('start')}
          </Button>
        </div>
      )}
    </div>
  );
}
