'use client';

import { Banner, CheckboxRow, Select, TextAreaField, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { languageName } from '../business-activities/activity-form.ts';
import {
  googlePreview,
  localeOf,
  missingIn,
  withLocale,
  type EditForm,
  type FieldErrors,
} from './edit-model.ts';
import { directionOf } from './tree-model.ts';
import {
  KEYWORDS_MAX,
  NAME_MAX,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  SHORT_DESCRIPTION_MAX,
} from './types.ts';

/** The message of a field problem, or undefined when there is none. */
export function useFieldMessage(errors: FieldErrors) {
  const t = useTranslations('categories.form');
  return (path: string): string | undefined => {
    const code = errors[path];
    if (code === undefined) return undefined;
    return t.has(`error.${code}`) ? t(`error.${code}`) : t('error.unknown');
  };
}

/**
 * The words of the language the admin is filling in. One language at a time, picked from a
 * dropdown (a language that has no name yet is marked Missing). Persian and Arabic fields read
 * right to left; the rest of the form stays left to right.
 */
export function ContentFields({
  form,
  onChange,
  errors,
  supported,
  required,
  active,
  onActive,
}: {
  readonly form: EditForm;
  readonly onChange: (next: EditForm) => void;
  readonly errors: FieldErrors;
  readonly supported: readonly string[];
  readonly required: readonly string[];
  readonly active: string;
  readonly onActive: (locale: string) => void;
}) {
  const t = useTranslations('categories.form');
  const message = useFieldMessage(errors);
  const missing = new Set(missingIn(form, supported));
  const entry = localeOf(form, active);
  const dir = directionOf(active);
  const base = `texts.${active}`;
  const options = supported.map((locale) => ({
    value: locale,
    label: [
      languageName(locale),
      required.includes(locale) ? t('required-mark') : null,
      missing.has(locale) ? t('missing-mark') : null,
    ]
      .filter((part) => part !== null)
      .join(' · '),
  }));
  const anyError = Object.keys(errors).some(
    (path) => path.startsWith('texts.') && !path.startsWith(`${base}.`),
  );
  return (
    <div className="flex flex-col gap-4">
      {supported.length > 1 ? (
        <Select
          label={t('language')}
          help={t('language-help')}
          value={active}
          options={options}
          onChange={(event) => onActive(event.target.value)}
        />
      ) : null}
      {anyError ? <Banner tone="critical">{t('other-language-error')}</Banner> : null}
      <TextField
        key={`${active}-name`}
        name={`name-${active}`}
        label={t('name', { language: languageName(active) })}
        value={entry.name}
        dir={dir}
        lang={active}
        maxLength={NAME_MAX}
        autoComplete="off"
        error={message(`${base}.name`)}
        help={required.includes(active) ? undefined : t('name-optional')}
        onChange={(event) => onChange(withLocale(form, active, { name: event.target.value }))}
      />
      <TextAreaField
        key={`${active}-short`}
        name={`short-${active}`}
        label={t('short-description')}
        optionalLabel={t('optional')}
        rows={3}
        dir={dir}
        lang={active}
        value={entry.shortDescription}
        maxLength={SHORT_DESCRIPTION_MAX}
        counter={`${entry.shortDescription.length} / ${SHORT_DESCRIPTION_MAX}`}
        error={message(`${base}.shortDescription`)}
        onChange={(event) =>
          onChange(withLocale(form, active, { shortDescription: event.target.value }))
        }
      />
      <TextAreaField
        key={`${active}-keywords`}
        name={`keywords-${active}`}
        label={t('keywords')}
        optionalLabel={t('optional')}
        help={t('keywords-help', { max: KEYWORDS_MAX })}
        rows={2}
        dir={dir}
        lang={active}
        value={entry.keywords}
        error={message(`${base}.keywords`)}
        onChange={(event) => onChange(withLocale(form, active, { keywords: event.target.value }))}
      />
      <CheckboxRow
        label={t('show-in-menu')}
        help={t('show-in-menu-help')}
        checked={form.showInMenu}
        onChange={(event) => onChange({ ...form, showInMenu: event.target.checked })}
      />
    </div>
  );
}

/** The search-engine words (English only) with a preview of how a result may look. */
export function SeoFields({
  form,
  onChange,
  errors,
  slug,
  defaultLocale,
}: {
  readonly form: EditForm;
  readonly onChange: (next: EditForm) => void;
  readonly errors: FieldErrors;
  readonly slug: string;
  readonly defaultLocale: string;
}) {
  const t = useTranslations('categories.form');
  const message = useFieldMessage(errors);
  const fallback = localeOf(form, defaultLocale);
  const preview = googlePreview({
    host: t('preview-host'),
    slug: slug === '' ? t('preview-slug') : slug,
    seoTitle: form.seoTitle,
    seoDescription: form.seoDescription,
    name: fallback.name,
    shortDescription: fallback.shortDescription,
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">{t('seo-help')}</p>
      <TextField
        name="seo-title"
        label={t('seo-title')}
        optionalLabel={t('optional')}
        value={form.seoTitle}
        dir="ltr"
        lang="en"
        maxLength={SEO_TITLE_MAX}
        autoComplete="off"
        help={`${form.seoTitle.length} / ${SEO_TITLE_MAX}`}
        error={message('seo.title')}
        onChange={(event) => onChange({ ...form, seoTitle: event.target.value })}
      />
      <TextAreaField
        name="seo-description"
        label={t('seo-description')}
        optionalLabel={t('optional')}
        rows={3}
        dir="ltr"
        lang="en"
        value={form.seoDescription}
        maxLength={SEO_DESCRIPTION_MAX}
        counter={`${form.seoDescription.length} / ${SEO_DESCRIPTION_MAX}`}
        error={message('seo.description')}
        onChange={(event) => onChange({ ...form, seoDescription: event.target.value })}
      />
      <CheckboxRow
        label={t('noindex')}
        help={t('noindex-help')}
        checked={form.noindex}
        onChange={(event) => onChange({ ...form, noindex: event.target.checked })}
      />
      <section
        aria-label={t('preview-label')}
        className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-4"
        dir="ltr"
      >
        <p className="text-xs text-fg-muted">{t('preview-label')}</p>
        <p className="m-0 break-all text-sm text-fg-muted" data-testid="preview-url">
          {preview.url}
        </p>
        <p className="m-0 text-lg text-link" data-testid="preview-title">
          {preview.title}
        </p>
        <p className="m-0 text-sm" data-testid="preview-description">
          {preview.description}
        </p>
      </section>
    </div>
  );
}
