'use client';

import { Banner, Button, LinkButton, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useLayoutEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';

export const TAG_LABEL_MIN = 2;
export const TAG_LABEL_MAX = 40;

/** Where a refused tag suggestion is told: at the field, or in the banner at the top. */
export interface TagSuggestionError {
  /** A key under `catalog.tagSuggestions.new.error`. */
  readonly key: string;
  readonly place: 'field' | 'banner';
  readonly max?: number | undefined;
  /** The banner offers the seller's list ("View my suggestions"). */
  readonly list?: boolean;
  /** The banner offers the product ("Back to my product"). */
  readonly product?: boolean;
}

const BY_CODE: Readonly<Record<string, TagSuggestionError>> = {
  'suggestion.topic-exists': { key: 'exists', place: 'field', product: true },
  'suggestion.already-open': { key: 'already-open', place: 'banner', list: true },
  'suggestion.limit-reached': { key: 'limit', place: 'banner', list: true },
  'suggestion.label-invalid': { key: 'invalid', place: 'field' },
  'validation.failed': { key: 'invalid', place: 'field' },
  'topic.claim-word': { key: 'claim-word', place: 'field' },
  'topic.locale-uncheckable': { key: 'unchecked', place: 'field' },
  'product.not-found': { key: 'product-not-found', place: 'banner' },
  'product.not-editable': { key: 'product-not-editable', place: 'banner' },
  'seller.not-eligible': { key: 'not-eligible', place: 'banner' },
  'access.seller-not-approved': { key: 'not-eligible', place: 'banner' },
  'access.denied': { key: 'denied', place: 'banner' },
  'request.csrf': { key: 'csrf', place: 'banner' },
  'request.throttled': { key: 'throttled', place: 'banner' },
};

/** The message for a refused request; an unknown 4xx is "unknown", no answer or 5xx "unreachable". */
export function tagSuggestionError(failure: {
  readonly status: number;
  readonly code: string;
  readonly details?: { readonly max?: number };
}): TagSuggestionError {
  if (failure.code === 'access.unavailable' || failure.status === 0 || failure.status >= 500) {
    return { key: 'unreachable', place: 'banner' };
  }
  const known = BY_CODE[failure.code];
  if (known === undefined) return { key: 'unknown', place: 'banner' };
  return failure.code === 'suggestion.limit-reached'
    ? { ...known, max: failure.details?.max }
    : known;
}

/**
 * The "Suggest a tag" form (product tags T5c): one product of the seller and the tag they want.
 * Nothing is added to the product; on success the page goes to the list, which shows the new
 * suggestion as open. The text is checked for its length before any request.
 */
export function SuggestTagForm({
  products,
  initialProduct,
  initialLabel,
  language,
  openCount,
  maxOpen,
  csrfToken,
}: {
  readonly products: readonly { readonly id: string; readonly label: string }[];
  /** A product to start on (from the product form's link), when the seller has it. */
  readonly initialProduct?: string | undefined;
  readonly initialLabel?: string | undefined;
  /** The Market's default language, named in words. */
  readonly language: string;
  readonly openCount: number;
  readonly maxOpen: number;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.tagSuggestions.new');
  const start =
    initialProduct !== undefined && products.some((product) => product.id === initialProduct)
      ? initialProduct
      : products.length === 1
        ? (products[0]?.id ?? '')
        : '';
  const [productId, setProductId] = useState(start);
  const [label, setLabel] = useState((initialLabel ?? '').slice(0, TAG_LABEL_MAX));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TagSuggestionError | null>(null);
  const [lengthError, setLengthError] = useState(false);
  const busy = useRef(false);
  const alertBox = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const full = openCount >= maxOpen;

  // A refusal in the banner takes focus, so a screen reader reads it and the keyboard starts there.
  // A layout effect moves focus in the same commit that adds the banner: a passive effect runs
  // later, so for a moment the banner is on screen while focus is still on the body.
  useLayoutEffect(() => {
    if (error?.place === 'banner') alertBox.current?.focus();
  }, [error]);

  async function send() {
    if (busy.current || productId === '') return;
    const text = label.trim();
    if (text.length < TAG_LABEL_MIN || text.length > TAG_LABEL_MAX) {
      setLengthError(true);
      form.current?.querySelector<HTMLElement>('input[name="label"]')?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    setLengthError(false);
    const result = await callApi(
      'POST',
      `catalog/seller/products/${productId}/topic-suggestions`,
      { label: text },
      csrfToken,
    );
    if (result.ok) {
      window.location.assign('/tag-suggestions?sent=1');
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(tagSuggestionError(result.failure));
  }

  const fieldError = lengthError
    ? t('error.length')
    : error?.place === 'field'
      ? t(`error.${error.key}`, { max: error.max ?? maxOpen })
      : undefined;
  return (
    <form
      ref={form}
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {error?.place === 'banner' ? (
        <div ref={alertBox} tabIndex={-1} className="flex flex-col gap-2 outline-none">
          <Banner tone="critical">{t(`error.${error.key}`, { max: error.max ?? maxOpen })}</Banner>
          {error.list === true ? (
            <a className="text-sm text-link underline" href="/tag-suggestions">
              {t('view-suggestions')}
            </a>
          ) : null}
        </div>
      ) : null}
      <Select
        name="product"
        label={t('product')}
        placeholder={t('product-placeholder')}
        help={t('product-help')}
        options={products.map((product) => ({ value: product.id, label: product.label }))}
        value={productId}
        onChange={(event) => setProductId(event.target.value)}
        disabled={pending}
        required
      />
      <TextField
        name="label"
        label={t('label')}
        help={
          <>
            {t('help', { language })}{' '}
            <span data-testid="tag-counter">{t('counter', { count: label.length })}</span>
          </>
        }
        error={fieldError}
        value={label}
        maxLength={TAG_LABEL_MAX}
        autoComplete="off"
        readOnly={pending}
        onChange={(event) => {
          setLabel(event.target.value);
          setLengthError(false);
        }}
        required
      />
      {error?.place === 'field' && error.product === true && productId !== '' ? (
        <a className="text-sm text-link underline" href={`/products/${productId}`}>
          {t('back-to-product')}
        </a>
      ) : null}
      <p className="text-sm text-fg-muted">{t('used', { count: openCount, max: maxOpen })}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Button
          type="submit"
          loading={pending}
          disabled={pending || full || productId === '' || label.trim() === ''}
          className="w-full sm:w-auto"
        >
          {t('send')}
        </Button>
        <LinkButton href="/tag-suggestions" variant="secondary" className="w-full sm:w-auto">
          {t('cancel')}
        </LinkButton>
      </div>
    </form>
  );
}
