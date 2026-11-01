'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  SearchSelect,
  TextAreaField,
  TextField,
  type SearchSelectLabels,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { shortId } from '../shared/short-id.ts';
import {
  bodyOf,
  categoryOptions,
  checkForm,
  emptyForm,
  fieldsOf,
  formOf,
  hasErrors,
  languageName,
  suggestCode,
  type ActivityFormState,
  type FieldErrors,
} from './activity-form.ts';
import {
  API_ACTIVITIES,
  API_CATEGORIES,
  CATEGORIES_MAX,
  CODE_MAX,
  DESCRIPTION_MAX,
  NAME_MAX,
  type ActivityRow,
  type ActivityWrap,
  type CategoryTree,
  type Locales,
} from './types.ts';
import { useActivityCall } from './use-activity-call.ts';

type CategoryLoad =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly options: readonly SearchSelectOption[] };

/**
 * The activity form in a dialog: a new activity or the whole content of an existing one. Names are
 * language rows (the Market's default language is required and first; more languages are added
 * from a searchable list). The code is suggested from the default name while creating and is fixed
 * afterwards. Categories are picked from levels 1 and 2 of the category tree.
 */
export function ActivityFormDialog({
  activity,
  locales,
  csrfToken,
  onClose,
  onSaved,
  onStale,
}: {
  /** The activity to edit; absent for a new one. */
  readonly activity?: ActivityRow;
  readonly locales: Locales;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (activity: ActivityRow) => void;
  /** The activity changed meanwhile: the dialog is closed and the list read again. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('business-activities.form');
  const tr = useTranslations();
  const editing = activity !== undefined;
  const [form, setForm] = useState<ActivityFormState>(
    activity === undefined ? emptyForm(locales.default) : formOf(activity, locales.default),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [categories, setCategories] = useState<CategoryLoad>({ state: 'loading' });
  const call = useActivityCall(csrfToken);

  const loadCategories = useCallback(async () => {
    setCategories({ state: 'loading' });
    const result = await callApi<CategoryTree>('GET', API_CATEGORIES);
    setCategories(
      result.ok ? { state: 'ready', options: categoryOptions(result.body) } : { state: 'failed' },
    );
  }, []);
  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const labels: Partial<SearchSelectLabels> = {
    search: t('select.search'),
    noResults: t('select.no-results'),
    loading: t('select.loading'),
    retry: t('select.retry'),
    remove: (name) => t('select.remove', { name }),
    limitReached: (max) => t('select.limit', { max }),
  };

  const defaultName = form.names[0]?.name ?? '';
  const suggested = suggestCode(defaultName);
  const have = new Set(form.names.map((row) => row.locale));
  const addable: readonly SearchSelectOption[] = locales.supported
    .filter((locale) => !have.has(locale))
    .map((locale) => ({ value: locale, label: languageName(locale), description: locale }));
  const named = form.names
    .filter((row) => row.name.trim() !== '')
    .map((row) => languageName(row.locale));

  const picked = useMemo<readonly SearchSelectOption[]>(() => {
    const known = new Map(
      (categories.state === 'ready' ? categories.options : []).map((o) => [o.value, o]),
    );
    return form.categoryIds.map(
      (id) => known.get(id) ?? { value: id, label: t('category-fallback', { id: shortId(id) }) },
    );
  }, [categories, form.categoryIds, t]);

  const setName = (locale: string, name: string) => {
    setForm((current) => ({
      ...current,
      names: current.names.map((row) => (row.locale === locale ? { ...row, name } : row)),
    }));
    setErrors((current) => {
      const rest = { ...current.names };
      delete rest[locale];
      return { ...current, names: rest };
    });
  };
  const setField = <K extends 'code' | 'description' | 'active'>(
    name: K,
    value: ActivityFormState[K],
  ) => {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  };
  const msg = (code: string | undefined): string | undefined =>
    code === undefined ? undefined : t(`error.${code}`);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = checkForm(form, locales.default, !editing);
    setErrors(found);
    if (hasErrors(found)) return;
    const body = bodyOf(form, !editing);
    const answer = editing
      ? await call.run<ActivityWrap>('PUT', `${API_ACTIVITIES}/${activity.id}`, {
          ...body,
          version: activity.version,
        })
      : await call.run<ActivityWrap>('POST', API_ACTIVITIES, body);
    if (!answer.ok) {
      if (answer.problem !== null) setErrors(fieldsOf(answer.problem.fields));
      return;
    }
    onSaved(answer.body.activity);
  }

  const problem = call.problem;
  const formId = 'activity-form';
  const title = editing
    ? t('edit-title', { name: activity.names[locales.default] ?? activity.code })
    : t('new-title');

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onStale}>{t('reload')}</Button>
          ) : (
            <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
              {editing ? t('save') : t('create')}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {problem === null ? null : <Banner tone="critical">{tr(problem.key)}</Banner>}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-fg">{t('names')}</legend>
          <p className="text-sm text-fg-muted">
            {t('names-help', { language: languageName(locales.default) })}
          </p>
          {form.names.map((row, index) => (
            <div key={row.locale} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  name={`name-${row.locale}`}
                  label={
                    index === 0
                      ? t('name-default', { language: languageName(row.locale) })
                      : languageName(row.locale)
                  }
                  value={row.name}
                  maxLength={NAME_MAX}
                  error={msg(errors.names?.[row.locale])}
                  autoComplete="off"
                  onChange={(event) => setName(row.locale, event.target.value)}
                />
              </div>
              {index === 0 ? null : (
                <Button
                  variant="secondary"
                  aria-label={t('remove-language', { language: languageName(row.locale) })}
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      names: current.names.filter((other) => other.locale !== row.locale),
                    }))
                  }
                >
                  {t('remove')}
                </Button>
              )}
            </div>
          ))}
          {named.length > 1 ? (
            <p className="text-sm text-fg-muted">
              {t('named-in', { languages: named.join(', ') })}
            </p>
          ) : null}
          {addable.length === 0 ? null : (
            <SearchSelect
              label={t('add-language')}
              placeholder={t('add-language-placeholder')}
              options={addable}
              value={null}
              alwaysSearch
              labels={labels}
              onChange={(option) => {
                if (option === null) return;
                setForm((current) => ({
                  ...current,
                  names: [...current.names, { locale: option.value, name: '' }],
                }));
              }}
            />
          )}
        </fieldset>
        <TextAreaField
          name="description"
          label={t('description')}
          optionalLabel={t('optional')}
          rows={3}
          value={form.description}
          maxLength={DESCRIPTION_MAX}
          error={msg(errors.description)}
          counter={`${form.description.length} / ${DESCRIPTION_MAX}`}
          onChange={(event) => setField('description', event.target.value)}
        />
        <TextField
          name="code"
          label={t('code')}
          help={editing ? t('code-locked') : t('code-help')}
          value={form.code}
          placeholder={editing ? undefined : suggested}
          readOnly={editing}
          maxLength={CODE_MAX}
          error={msg(errors.code)}
          autoComplete="off"
          onChange={(event) => setField('code', event.target.value)}
        />
        <SearchSelect
          multiple
          label={t('categories')}
          placeholder={t('categories-placeholder')}
          help={t('categories-help')}
          options={categories.state === 'ready' ? categories.options : []}
          value={picked}
          max={CATEGORIES_MAX}
          alwaysSearch
          loading={categories.state === 'loading'}
          loadError={categories.state === 'failed' ? t('categories-error') : undefined}
          onRetry={() => void loadCategories()}
          error={msg(errors.categoryIds)}
          labels={labels}
          onChange={(value) =>
            setForm((current) => ({ ...current, categoryIds: value.map((option) => option.value) }))
          }
        />
        <CheckboxRow
          label={t('active')}
          help={t('active-help')}
          checked={form.active}
          onChange={(event) => setField('active', event.target.checked)}
        />
      </form>
    </Dialog>
  );
}
