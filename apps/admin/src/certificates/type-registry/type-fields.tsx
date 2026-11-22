'use client';

import { CheckboxRow, Select, TextAreaField, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';

// The Rules and Wording fieldsets of the certificate type forms (the New type page and the change
// form share them; design FE-091 N2) and the helpers both forms validate with.

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const TERM_MAX = 100;
export const TERMS_MAX = 200;
export const DEFAULT_BASES = ['SELLER_REQUIRED', 'NOT_APPLICABLE'] as const;

export interface LocaleDraft {
  name: string;
  description: string;
  /** One term per line. */
  terms: string;
}

export interface RulesDraft {
  requiresIssuerRegistry: boolean;
  requiresDocument: boolean;
  requiresExpiry: boolean;
  defaultBasis: string;
  autoApprove: boolean;
  icon: string;
}

export const termsOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The rules a check method forces: a document for an issuer's certificate, no issuer for a declaration. */
export function normaliseRules(mode: string, rules: RulesDraft): RulesDraft {
  return {
    ...rules,
    requiresDocument: mode === 'THIRD_PARTY_DOCUMENT' ? true : rules.requiresDocument,
    requiresIssuerRegistry: mode === 'SELF_DECLARATION' ? false : rules.requiresIssuerRegistry,
    autoApprove: mode === 'SELF_DECLARATION' ? rules.autoApprove : false,
  };
}

/** The key of the artwork that shows the type's name as text; the API lists it with the others. */
export const TEXT_ARTWORK = 'text';

/** Marks a field the error summary can move focus to. */
const fieldMark = (name: string) => ({ 'data-field': name });

export function RulesFields({
  variant,
  mode,
  value,
  onChange,
  artworkKeys,
  bases,
  errors,
  lead,
}: {
  readonly variant: 'new' | 'edit';
  /** The check method; empty until chosen on the New type page. */
  readonly mode: string;
  readonly value: RulesDraft;
  readonly onChange: (patch: Partial<RulesDraft>) => void;
  readonly artworkKeys: readonly string[];
  readonly bases: readonly string[];
  readonly errors: { readonly icon?: string | undefined; readonly auto?: string | undefined };
  readonly lead?: ReactNode;
}) {
  const t = useTranslations('certificates.types.revise');
  const td = useTranslations('certificates.types.detail');
  const tb = useTranslations('certificates.types.basis');
  const tf = useTranslations('certificates.types.fields');
  const basis = (key: string) => (tb.has(key as never) ? tb(key as never) : key);
  const third = mode === 'THIRD_PARTY_DOCUMENT';
  const self = mode === 'SELF_DECLARATION';
  // A key the type already has stays choosable even if the API no longer lists it.
  const keys =
    value.icon === '' || artworkKeys.includes(value.icon)
      ? artworkKeys
      : [value.icon, ...artworkKeys];
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <legend className="px-1 text-base font-semibold">
        {variant === 'new' ? tf('rules') : t('settings')}
      </legend>
      {lead}
      {self ? null : (
        <CheckboxRow
          label={td('needs-issuer')}
          checked={value.requiresIssuerRegistry}
          onChange={(event) => onChange({ requiresIssuerRegistry: event.target.checked })}
        />
      )}
      <CheckboxRow
        label={td('needs-document')}
        {...(third ? { help: tf('document-locked'), disabled: true } : {})}
        checked={third ? true : value.requiresDocument}
        onChange={(event) => onChange({ requiresDocument: event.target.checked })}
      />
      <CheckboxRow
        label={td('needs-expiry')}
        checked={value.requiresExpiry}
        onChange={(event) => onChange({ requiresExpiry: event.target.checked })}
      />
      <Select
        label={td('default-basis')}
        value={value.defaultBasis}
        onChange={(event) => onChange({ defaultBasis: event.target.value })}
        options={bases.map((key) => ({ value: key, label: basis(key) }))}
      />
      {self ? (
        <CheckboxRow
          label={td('auto-approve')}
          help={variant === 'new' ? tf('auto-help') : t('auto-help')}
          checked={value.autoApprove}
          onChange={(event) => onChange({ autoApprove: event.target.checked })}
        />
      ) : null}
      <Select
        label={variant === 'new' ? tf('artwork') : td('icon')}
        value={value.icon}
        onChange={(event) => onChange({ icon: event.target.value })}
        options={keys.map((key) => ({
          value: key,
          label: key === TEXT_ARTWORK ? tf('artwork-text') : key,
        }))}
        {...(value.icon === '' ? { placeholder: tf('artwork-choose') } : {})}
        help={tf('artwork-help')}
        error={errors.icon}
        {...fieldMark('icon')}
      />
    </fieldset>
  );
}

export function WordingFields({
  variant,
  locales,
  onChange,
  errors,
  limits,
}: {
  readonly variant: 'new' | 'edit';
  readonly locales: Readonly<Record<string, LocaleDraft>>;
  readonly onChange: (code: string, patch: Partial<LocaleDraft>) => void;
  /** Error text by field: `name-<locale>`, `description-<locale>`, `terms-<locale>`, `terms`. */
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly limits?: { readonly name: number; readonly description: number };
}) {
  const t = useTranslations('certificates.types.revise');
  const td = useTranslations('certificates.types.detail');
  const tf = useTranslations('certificates.types.fields');
  const isNew = variant === 'new';
  const nameMax = limits?.name ?? NAME_MAX;
  const descriptionMax = limits?.description ?? DESCRIPTION_MAX;
  return (
    <>
      {Object.entries(locales).map(([code, text]) => (
        <fieldset
          key={code}
          lang={code}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <legend className="px-1 text-base font-semibold">
            {isNew ? tf('wording', { locale: code }) : td('locale', { locale: code })}
          </legend>
          <TextField
            label={isNew ? tf('name') : td('locale-name')}
            value={text.name}
            onChange={(event) => onChange(code, { name: event.target.value })}
            error={errors[`name-${code}`]}
            help={isNew ? tf('name-help', { max: nameMax }) : t('name-help', { max: nameMax })}
            dir="auto"
            autoComplete="off"
            {...fieldMark(`name-${code}`)}
          />
          <TextAreaField
            label={isNew ? tf('description') : td('locale-description')}
            rows={3}
            value={text.description}
            onChange={(event) => onChange(code, { description: event.target.value })}
            error={errors[`description-${code}`]}
            help={
              isNew
                ? tf('description-help', { max: descriptionMax })
                : t('description-help', { max: descriptionMax })
            }
            dir="auto"
            {...fieldMark(`description-${code}`)}
          />
          <TextAreaField
            label={isNew ? tf('terms') : td('locale-terms')}
            rows={6}
            value={text.terms}
            onChange={(event) => onChange(code, { terms: event.target.value })}
            error={errors[`terms-${code}`] ?? errors['terms']}
            help={isNew ? tf('terms-help') : t('terms-help', { term: TERM_MAX, terms: TERMS_MAX })}
            dir="auto"
            {...fieldMark(`terms-${code}`)}
          />
        </fieldset>
      ))}
    </>
  );
}

/**
 * The problems of a form in one place above it: the page moves focus here when a send fails, and
 * each entry moves focus to its field.
 */
export function ErrorSummary({
  items,
  focusKey,
}: {
  readonly items: readonly { readonly field: string; readonly text: string }[];
  /** Changes on each failed send; the summary takes focus then. */
  readonly focusKey: number;
}) {
  const t = useTranslations('certificates.types.fields');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusKey > 0) ref.current?.focus();
  }, [focusKey]);
  if (items.length === 0) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-label={t('summary-label')}
      className="rounded-md border border-critical-border bg-critical-bg px-4 py-3 text-sm text-critical-fg"
    >
      <p className="font-semibold">{t('summary', { count: items.length })}</p>
      <ul className="mt-1 list-disc ps-5">
        {items.map((item) => (
          <li key={item.field}>
            <a
              href={`#${item.field}`}
              className="underline"
              onClick={(event) => {
                event.preventDefault();
                document.querySelector<HTMLElement>(`[data-field="${item.field}"]`)?.focus();
              }}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
