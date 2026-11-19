'use client';

import { Banner, Button, LinkButton, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { SUGGESTION_ERRORS } from './suggest-value.tsx';
import type { SuggestableField } from './suggestion-fields.ts';

const LABEL_MAX = 120;

/**
 * The "Suggest a value" form of the Value suggestions page: for one product of the seller, pick a
 * select field and say the value it lacks. The request is the product form's own (attributes A5);
 * on success the page goes back to the list, which shows the new suggestion as waiting.
 */
export function SuggestValueForm({
  productId,
  fields,
  initialField,
  csrfToken,
}: {
  readonly productId: string;
  readonly fields: readonly SuggestableField[];
  /** A field to start on (from a link such as the variant editor's), when the product has it. */
  readonly initialField?: string | undefined;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.suggestions.new');
  const tError = useTranslations('catalog.edit.attribute.suggest');
  const start =
    initialField !== undefined && fields.some((field) => field.code === initialField)
      ? initialField
      : fields.length === 1
        ? (fields[0]?.code ?? '')
        : '';
  const [code, setCode] = useState(start);
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const chosen = fields.find((field) => field.code === code);

  async function send() {
    if (busy.current || chosen === undefined) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await callApi(
      'POST',
      `catalog/seller/products/${productId}/attribute-suggestions`,
      { attributeCode: chosen.code, label: label.trim() },
      csrfToken,
    );
    if (result.ok) {
      window.location.assign('/value-suggestions?sent=1');
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(
      SUGGESTION_ERRORS[result.failure.code] ??
        (result.failure.status === 0 || result.failure.status >= 500 ? 'unreachable' : 'unknown'),
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {error === null ? null : (
        <Banner tone="critical">
          {/* The product form's wording points at its own list; this page has none above. */}
          {error === 'value-exists' ? t('value-exists') : tError(`error.${error}`)}
        </Banner>
      )}
      <Select
        name="attributeCode"
        label={t('field')}
        placeholder={t('field-placeholder')}
        options={fields.map((field) => ({ value: field.code, label: field.label }))}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        // The values the field has now, tied to the field so a screen reader reads them with it.
        help={
          chosen === undefined
            ? undefined
            : chosen.values.length === 0
              ? t('values-none')
              : t('values', { values: chosen.values.join(', ') })
        }
        required
      />
      <TextField
        name="label"
        label={t('label')}
        help={t('help')}
        value={label}
        maxLength={LABEL_MAX}
        autoComplete="off"
        onChange={(event) => setLabel(event.target.value)}
        required
      />
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          loading={pending}
          disabled={pending || chosen === undefined || label.trim() === ''}
        >
          {t('send')}
        </Button>
        <LinkButton href="/value-suggestions" variant="secondary">
          {t('cancel')}
        </LinkButton>
      </div>
    </form>
  );
}
