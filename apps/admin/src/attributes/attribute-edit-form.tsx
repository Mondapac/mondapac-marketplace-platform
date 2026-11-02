'use client';

import {
  Badge,
  Banner,
  Button,
  CheckboxRow,
  IconButton,
  SearchSelect,
  TextAreaField,
  TextField,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import {
  HELP_MAX,
  NAME_MAX,
  NOTE_MAX,
  OPTIONS_MAX,
  checkForm,
  contentOf,
  fieldKey,
  formOf,
  missingLocales,
  moved,
  newValue,
  type EditorForm,
  type FieldErrors,
  type ValueRow,
} from './editor.ts';
import { useSelectLabels } from './select-labels.ts';
import {
  API_ATTRIBUTES,
  CHOICE_TYPES,
  directionOf,
  languageName,
  type AttributeDetail,
  type AttributeWrite,
} from './types.ts';
import { useAttributeCall } from './use-attribute-call.ts';

/**
 * Edit an attribute (attributes A2): every save is a new revision. The texts are edited one
 * language at a time, chosen from one "Language" dropdown, with a "Missing" badge for each
 * language still incomplete. The values table shows the default language and, on request, one
 * more language next to it; a saved value is never removed, only made inactive. Once published,
 * the variant flag is fixed and Material can be turned on but not off here (clearing it needs a
 * second administrator). A save over a newer version is refused: the admin reloads.
 */
export function AttributeEditForm({
  detail,
  csrfToken,
  onCancel,
  onSaved,
  onReload,
}: {
  readonly detail: AttributeDetail;
  readonly csrfToken: string;
  readonly onCancel: () => void;
  readonly onSaved: (write: AttributeWrite) => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('attributes.editor');
  const selectLabels = useSelectLabels();
  const { locales, dataType } = detail;
  const [form, setForm] = useState<EditorForm>(() => formOf(detail));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [locale, setLocale] = useState(locales.default);
  const [second, setSecond] = useState('');
  const call = useAttributeCall(csrfToken);
  const published = detail.status !== 'draft';
  const choice = CHOICE_TYPES.has(dataType);
  const nameOf = (tag: string) => languageName(tag, locales.supported);
  const defaultLanguage = nameOf(locales.default);
  const language = nameOf(locale);
  const missing = missingLocales(form, dataType, locales.supported);

  const msg = (path: string) => {
    const reason = errors[path];
    return reason === undefined ? undefined : t(`field.${fieldKey(reason)}`);
  };
  const clearError = (path: string) =>
    setErrors((current) => {
      if (current[path] === undefined) return current;
      const rest = { ...current };
      delete rest[path];
      return rest;
    });
  const patch = (next: Partial<EditorForm>) => setForm((current) => ({ ...current, ...next }));
  const setText = (key: 'names' | 'helpText', tag: string, text: string) => {
    setForm((current) => ({ ...current, [key]: { ...current[key], [tag]: text } }));
    clearError(`${key}.${tag}`);
  };
  const setValue = (index: number, next: Partial<ValueRow>) =>
    setForm((current) => ({
      ...current,
      values: current.values.map((row, at) => (at === index ? { ...row, ...next } : row)),
    }));
  const setLabel = (index: number, tag: string, text: string) => {
    setForm((current) => ({
      ...current,
      values: current.values.map((row, at) =>
        at === index ? { ...row, labels: { ...row.labels, [tag]: text } } : row,
      ),
    }));
    clearError(`options[${index}].labels.${tag}`);
  };

  const languageOptions: readonly SearchSelectOption[] = locales.supported.map((tag) => ({
    value: tag,
    label: nameOf(tag),
    description: missing.includes(tag) ? t('missing-short') : tag,
  }));
  const secondOptions: readonly SearchSelectOption[] = locales.supported
    .filter((tag) => tag !== locales.default)
    .map((tag) => ({ value: tag, label: nameOf(tag) }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = checkForm(form, dataType, locales.default);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setLocale(locales.default);
      return;
    }
    const answer = await call.run<AttributeWrite>(
      'PUT',
      `${API_ATTRIBUTES}/${encodeURIComponent(detail.id)}`,
      { version: detail.version, ...contentOf(form, dataType) },
      form.values,
    );
    if (!answer.ok) {
      if (answer.problem !== null) setErrors(answer.problem.fields);
      return;
    }
    onSaved(answer.body);
  }

  const formId = 'attribute-edit-form';
  const problem = call.problem;
  const otherErrors = Object.keys(errors).filter(
    (path) => !path.startsWith(`names.${locale}`) && !path.startsWith(`helpText.${locale}`),
  );

  return (
    <form
      id={formId}
      aria-label={t('label')}
      className="flex flex-col gap-5"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      {problem === null ? null : (
        <Banner tone="critical">
          <span className="flex flex-col items-start gap-2">
            <span>{t(`error.${problem.key}`)}</span>
            {problem.reload ? (
              <Button variant="secondary" onClick={onReload}>
                {t('reload')}
              </Button>
            ) : null}
          </span>
        </Banner>
      )}
      {otherErrors.length > 0 && problem === null ? (
        <Banner tone="critical">{t('fix-fields')}</Banner>
      ) : null}

      <section aria-labelledby="editor-text" className="flex flex-col gap-3">
        <h3 id="editor-text" className="font-semibold text-fg">
          {t('text')}
        </h3>
        <div className="max-w-xs">
          <SearchSelect
            label={t('language')}
            options={languageOptions}
            value={languageOptions.find((option) => option.value === locale) ?? null}
            labels={selectLabels}
            onChange={(option) => setLocale(option?.value ?? locales.default)}
          />
        </div>
        {missing.length > 0 ? (
          <span className="flex flex-wrap gap-2">
            {missing.map((tag) => (
              <Badge key={tag} tone="attention">
                {t('missing', { language: nameOf(tag) })}
              </Badge>
            ))}
          </span>
        ) : null}
        <TextField
          key={`name-${locale}`}
          name={`name-${locale}`}
          label={t('name', { language })}
          help={locale === locales.default ? t('name-required', { language }) : undefined}
          value={form.names[locale] ?? ''}
          maxLength={NAME_MAX}
          lang={locale}
          dir={directionOf(locale)}
          error={msg(`names.${locale}`)}
          autoComplete="off"
          onChange={(event) => setText('names', locale, event.target.value)}
        />
        <TextAreaField
          key={`help-${locale}`}
          name={`help-${locale}`}
          label={t('help-text', { language })}
          help={t('help-text-help')}
          optionalLabel={t('optional')}
          rows={2}
          value={form.helpText[locale] ?? ''}
          maxLength={HELP_MAX}
          lang={locale}
          dir={directionOf(locale)}
          error={msg(`helpText.${locale}`)}
          onChange={(event) => setText('helpText', locale, event.target.value)}
        />
      </section>

      {choice ? (
        <section aria-labelledby="editor-values" className="flex flex-col gap-3">
          <h3 id="editor-values" className="font-semibold text-fg">
            {t('values.title')}
          </h3>
          <p className="text-sm text-fg-muted">{t('values.help')}</p>
          {secondOptions.length > 0 ? (
            <div className="max-w-xs">
              <SearchSelect
                label={t('values.second', { language: defaultLanguage })}
                placeholder={t('values.second-none')}
                options={secondOptions}
                value={secondOptions.find((option) => option.value === second) ?? null}
                labels={selectLabels}
                clearLabel={t('values.second-clear')}
                onChange={(option) => setSecond(option?.value ?? '')}
              />
            </div>
          ) : null}
          {msg('options') === undefined ? null : (
            <p className="text-sm text-critical-fg">{msg('options')}</p>
          )}
          <ul
            aria-label={t('values.title')}
            className="divide-y divide-line rounded-md border border-line"
          >
            {form.values.map((row, index) => (
              <li key={row.key} className="flex flex-col gap-3 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm wrap-anywhere text-fg-muted">
                    {row.saved ? t('values.code', { code: row.code }) : t('values.new')}
                  </span>
                  <span className="flex items-center gap-1">
                    <IconButton
                      icon="chevron-up"
                      label={t('values.up', { number: index + 1 })}
                      disabled={index === 0}
                      onClick={() => patch({ values: moved(form.values, index, index - 1) })}
                    />
                    <IconButton
                      icon="chevron-down"
                      label={t('values.down', { number: index + 1 })}
                      disabled={index === form.values.length - 1}
                      onClick={() => patch({ values: moved(form.values, index, index + 1) })}
                    />
                    {row.saved ? null : (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          patch({ values: form.values.filter((_, at) => at !== index) })
                        }
                      >
                        {t('values.remove')}
                      </Button>
                    )}
                  </span>
                </div>
                <div className={second === '' ? '' : 'grid gap-3 sm:grid-cols-2'}>
                  <TextField
                    name={`value-${row.key}-${locales.default}`}
                    label={t('values.label', { number: index + 1, language: defaultLanguage })}
                    value={row.labels[locales.default] ?? ''}
                    maxLength={NAME_MAX}
                    lang={locales.default}
                    dir={directionOf(locales.default)}
                    error={
                      msg(`options[${index}].labels.${locales.default}`) ??
                      msg(`options[${index}].code`) ??
                      msg(`options[${index}]`)
                    }
                    autoComplete="off"
                    onChange={(event) => setLabel(index, locales.default, event.target.value)}
                  />
                  {second === '' ? null : (
                    <TextField
                      name={`value-${row.key}-${second}`}
                      label={t('values.label', { number: index + 1, language: nameOf(second) })}
                      value={row.labels[second] ?? ''}
                      maxLength={NAME_MAX}
                      lang={second}
                      dir={directionOf(second)}
                      status={
                        (row.labels[second] ?? '').trim() === '' ? (
                          <Badge tone="attention">{t('values.missing')}</Badge>
                        ) : undefined
                      }
                      error={msg(`options[${index}].labels.${second}`)}
                      autoComplete="off"
                      onChange={(event) => setLabel(index, second, event.target.value)}
                    />
                  )}
                </div>
                <CheckboxRow
                  label={t('values.active')}
                  help={row.saved ? t('values.active-help') : undefined}
                  checked={row.active}
                  onChange={(event) => setValue(index, { active: event.target.checked })}
                />
              </li>
            ))}
          </ul>
          <span>
            <Button
              variant="secondary"
              disabled={form.values.length >= OPTIONS_MAX}
              onClick={() => patch({ values: [...form.values, newValue()] })}
            >
              {t('values.add')}
            </Button>
          </span>
        </section>
      ) : null}

      <section aria-labelledby="editor-settings" className="flex flex-col gap-3">
        <h3 id="editor-settings" className="font-semibold text-fg">
          {t('settings.title')}
        </h3>
        {dataType === 'text' || dataType === 'long-text' ? (
          <TextField
            name="max-length"
            label={t('settings.max-length')}
            optionalLabel={t('optional')}
            inputMode="numeric"
            value={form.maxLength}
            error={msg('bounds.maxLength')}
            onChange={(event) => patch({ maxLength: event.target.value })}
          />
        ) : null}
        {dataType === 'integer' || dataType === 'decimal' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name="min"
              label={t('settings.min')}
              optionalLabel={t('optional')}
              inputMode="decimal"
              value={form.min}
              error={msg('bounds.min')}
              onChange={(event) => patch({ min: event.target.value })}
            />
            <TextField
              name="max"
              label={t('settings.max')}
              optionalLabel={t('optional')}
              inputMode="decimal"
              value={form.max}
              error={msg('bounds.max')}
              onChange={(event) => patch({ max: event.target.value })}
            />
          </div>
        ) : null}
        {dataType === 'select' ? (
          <CheckboxRow
            label={t('settings.variant')}
            help={published ? t('settings.variant-locked') : t('settings.variant-help')}
            checked={form.isVariantOption}
            disabled={published}
            onChange={(event) => patch({ isVariantOption: event.target.checked })}
          />
        ) : null}
        <CheckboxRow
          label={t('settings.material')}
          help={
            published && detail.material
              ? t('settings.material-locked')
              : t('settings.material-help')
          }
          checked={form.material}
          disabled={published && detail.material}
          onChange={(event) => patch({ material: event.target.checked })}
        />
        <CheckboxRow
          label={t('settings.show-on-product-page')}
          checked={form.showOnProductPage}
          onChange={(event) => patch({ showOnProductPage: event.target.checked })}
        />
        <CheckboxRow
          label={t('settings.searchable')}
          checked={form.searchable}
          onChange={(event) => patch({ searchable: event.target.checked })}
        />
        <CheckboxRow
          label={t('settings.can-be-filter')}
          checked={form.canBeFilter}
          onChange={(event) => patch({ canBeFilter: event.target.checked })}
        />
        <TextField
          name="position"
          label={t('settings.position')}
          help={t('settings.position-help')}
          inputMode="numeric"
          value={form.position}
          error={msg('position')}
          onChange={(event) => patch({ position: event.target.value })}
        />
        <TextAreaField
          name="internal-note"
          label={t('settings.internal-note')}
          help={t('settings.internal-note-help')}
          optionalLabel={t('optional')}
          rows={3}
          value={form.internalNote}
          maxLength={NOTE_MAX}
          error={msg('internalNote')}
          counter={`${form.internalNote.length} / ${NOTE_MAX}`}
          onChange={(event) => patch({ internalNote: event.target.value })}
        />
      </section>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={call.pending} disabled={call.pending}>
          {t('save')}
        </Button>
        <Button variant="secondary" disabled={call.pending} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
