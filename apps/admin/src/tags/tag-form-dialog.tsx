'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  SearchSelect,
  Select,
  TextAreaField,
  TextField,
  type SearchSelectLabels,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  bodyOf,
  checkForm,
  emptyForm,
  fieldsOf,
  formOf,
  hasErrors,
  languageName,
  rowKey,
  suggestSlug,
  type FieldErrors,
  type LanguageRow,
  type TagFormState,
} from './tag-form.ts';
import {
  API_TOPICS,
  INTRO_MAX,
  SLUG_MAX,
  TERM_MAX,
  TOPIC_GROUPS,
  type Locales,
  type TopicGroup,
  type TopicRow,
  type TopicWrap,
} from './types.ts';
import { useTagCall } from './use-tag-call.ts';

/** Where focus goes after the next render: a synonym row, or a language's Add synonym button. */
type FocusTarget =
  | { readonly kind: 'row'; readonly key: number }
  | { readonly kind: 'add'; readonly locale: string };

/**
 * The tag form in a dialog: a new tag or the whole content of an existing one. Names are language
 * rows (the Market's default language is required and first; more languages are added from a
 * searchable list), each with its own synonym rows. The slug is suggested from the default name
 * while creating and is fixed afterwards. The intro is in the default language only.
 */
export function TagFormDialog({
  topic,
  locales,
  maxSynonyms,
  csrfToken,
  onClose,
  onSaved,
  onStale,
}: {
  /** The tag to edit; absent for a new one. */
  readonly topic?: TopicRow;
  readonly locales: Locales;
  readonly maxSynonyms: number;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (topic: TopicRow) => void;
  /** The tag changed meanwhile: the dialog is closed and the list read again. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('tags.form');
  const tr = useTranslations();
  const editing = topic !== undefined;
  const [form, setForm] = useState<TagFormState>(
    topic === undefined ? emptyForm(locales.default) : formOf(topic, locales.default),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const root = useRef<HTMLFormElement>(null);
  const call = useTagCall(csrfToken);

  useEffect(() => {
    if (focus === null) return;
    const selector =
      focus.kind === 'row'
        ? `[data-synonym-row="${focus.key}"]`
        : `[data-add-synonym="${CSS.escape(focus.locale)}"]`;
    root.current?.querySelector<HTMLElement>(selector)?.focus();
    setFocus(null);
  }, [focus]);

  const labels: Partial<SearchSelectLabels> = {
    search: t('select.search'),
    noResults: t('select.no-results'),
    loading: t('select.loading'),
    retry: t('select.retry'),
    remove: (name) => t('select.remove', { name }),
    limitReached: (max) => t('select.limit', { max }),
  };

  const several = form.languages.length > 1;
  const defaultName = form.languages[0]?.name ?? '';
  const suggested = suggestSlug(defaultName);
  const have = new Set(form.languages.map((row) => row.locale));
  const addable: readonly SearchSelectOption[] = locales.supported
    .filter((locale) => !have.has(locale))
    .map((locale) => ({ value: locale, label: languageName(locale), description: locale }));
  const named = form.languages
    .filter((row) => row.name.trim() !== '')
    .map((row) => languageName(row.locale));

  const update = (locale: string, change: (row: LanguageRow) => LanguageRow) =>
    setForm((current) => ({
      ...current,
      languages: current.languages.map((row) => (row.locale === locale ? change(row) : row)),
    }));
  const clearName = (locale: string) =>
    setErrors((current) => {
      const names = { ...current.names };
      delete names[locale];
      return { ...current, names };
    });
  const clearSynonym = (key: number, locale: string) =>
    setErrors((current) => {
      const synonyms = { ...current.synonyms };
      delete synonyms[key];
      const synonymLists = { ...current.synonymLists };
      delete synonymLists[locale];
      return { ...current, synonyms, synonymLists };
    });

  const addSynonym = (locale: string) => {
    const key = rowKey();
    update(locale, (row) => ({ ...row, synonyms: [...row.synonyms, { key, text: '' }] }));
    setFocus({ kind: 'row', key });
  };
  const removeSynonym = (language: LanguageRow, index: number) => {
    const gone = language.synonyms[index];
    if (gone === undefined) return;
    update(language.locale, (row) => ({
      ...row,
      synonyms: row.synonyms.filter((other) => other.key !== gone.key),
    }));
    clearSynonym(gone.key, language.locale);
    const before = language.synonyms[index - 1];
    setFocus(
      before === undefined
        ? { kind: 'add', locale: language.locale }
        : { kind: 'row', key: before.key },
    );
  };
  // Enter in a synonym row adds the next row instead of sending the form.
  const onSynonymKey = (event: KeyboardEvent<HTMLInputElement>, language: LanguageRow) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (language.synonyms.length < maxSynonyms) addSynonym(language.locale);
  };

  const msg = (code: string | undefined, values?: Record<string, number>): string | undefined =>
    code === undefined ? undefined : t(`error.${code}`, values);
  const termMsg = (code: string | undefined) => msg(code, { max: TERM_MAX, maxSynonyms });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = checkForm(form, locales.default, !editing);
    setErrors(found);
    if (hasErrors(found)) return;
    const body = bodyOf(form, editing);
    const answer = editing
      ? await call.run<TopicWrap>('PUT', `${API_TOPICS}/${topic.id}`, {
          ...body,
          version: topic.version,
        })
      : await call.run<TopicWrap>('POST', API_TOPICS, body);
    if (!answer.ok) {
      if (answer.problem !== null) setErrors(fieldsOf(answer.problem.fields, form));
      return;
    }
    onSaved(answer.body.topic);
  }

  const problem = call.problem;
  const formId = 'tag-form';
  const title = editing
    ? t('edit-title', { name: topic.names[locales.default] ?? topic.slug })
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
        ref={root}
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
          {form.languages.map((row, index) => (
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
                  maxLength={TERM_MAX}
                  error={termMsg(errors.names?.[row.locale])}
                  autoComplete="off"
                  onChange={(event) => {
                    const name = event.target.value;
                    update(row.locale, (current) => ({ ...current, name }));
                    clearName(row.locale);
                  }}
                />
              </div>
              {index === 0 ? null : (
                <Button
                  variant="secondary"
                  aria-label={t('remove-language', { language: languageName(row.locale) })}
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      languages: current.languages.filter((other) => other.locale !== row.locale),
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
                  languages: [
                    ...current.languages,
                    { locale: option.value, name: '', synonyms: [] },
                  ],
                }));
              }}
            />
          )}
        </fieldset>
        <Select
          label={t('group')}
          value={form.group}
          error={msg(errors.group)}
          placeholder={t('group-placeholder')}
          options={TOPIC_GROUPS.map((group) => ({
            value: group,
            label: tr(`tags.group.${group}`),
          }))}
          onChange={(event) => {
            const group = event.target.value as TopicGroup;
            setForm((current) => ({ ...current, group }));
            setErrors((current) => ({ ...current, group: undefined }));
          }}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-fg">{t('synonyms')}</legend>
          <p className="text-sm text-fg-muted">{t('synonyms-help')}</p>
          {form.languages.map((language) => {
            const lang = languageName(language.locale);
            const full = language.synonyms.length >= maxSynonyms;
            const listError = errors.synonymLists?.[language.locale];
            return (
              <div
                key={language.locale}
                role="group"
                aria-label={t('synonyms-in', { language: lang })}
                className="flex flex-col gap-2"
              >
                {several ? <h3 className="text-sm font-medium text-fg">{lang}</h3> : null}
                {language.synonyms.map((row, index) => (
                  <div key={row.key} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1 basis-48">
                      <TextField
                        name={`synonym-${language.locale}-${row.key}`}
                        label={t('synonym-label', { n: index + 1, language: lang })}
                        value={row.text}
                        maxLength={TERM_MAX}
                        error={termMsg(errors.synonyms?.[row.key])}
                        autoComplete="off"
                        data-synonym-row={row.key}
                        onKeyDown={(event) => onSynonymKey(event, language)}
                        onChange={(event) => {
                          const text = event.target.value;
                          update(language.locale, (current) => ({
                            ...current,
                            synonyms: current.synonyms.map((other) =>
                              other.key === row.key ? { ...other, text } : other,
                            ),
                          }));
                          clearSynonym(row.key, language.locale);
                        }}
                      />
                    </div>
                    <Button
                      variant="secondary"
                      aria-label={
                        several
                          ? t('remove-synonym-in', { n: index + 1, language: lang })
                          : t('remove-synonym', { n: index + 1 })
                      }
                      onClick={() => removeSynonym(language, index)}
                    >
                      {t('remove')}
                    </Button>
                  </div>
                ))}
                {listError === undefined ? null : (
                  <p className="text-sm text-critical-fg" role="alert">
                    {termMsg(listError)}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    disabled={full}
                    data-add-synonym={language.locale}
                    aria-label={several ? t('add-synonym-in', { language: lang }) : undefined}
                    onClick={() => addSynonym(language.locale)}
                  >
                    {t('add-synonym')}
                  </Button>
                  <span className="text-sm text-fg-muted">
                    {t('synonyms-count', { count: language.synonyms.length, max: maxSynonyms })}
                  </span>
                  {full ? (
                    <span className="text-sm text-fg-muted">
                      {t('synonyms-limit', { max: maxSynonyms })}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </fieldset>
        <TextAreaField
          name="intro"
          label={t('intro')}
          optionalLabel={t('optional')}
          help={t('intro-help', { language: languageName(locales.default) })}
          rows={4}
          value={form.intro}
          maxLength={INTRO_MAX}
          error={msg(errors.intro)}
          counter={`${form.intro.length} / ${INTRO_MAX}`}
          onChange={(event) => {
            const intro = event.target.value;
            setForm((current) => ({ ...current, intro }));
            setErrors((current) => ({ ...current, intro: undefined }));
          }}
        />
        <TextField
          name="slug"
          label={t('slug')}
          help={editing ? t('slug-locked') : t('slug-help')}
          value={form.slug}
          placeholder={editing ? undefined : suggested}
          readOnly={editing}
          maxLength={SLUG_MAX}
          error={msg(errors.slug)}
          autoComplete="off"
          onChange={(event) => {
            const slug = event.target.value;
            setForm((current) => ({ ...current, slug }));
            setErrors((current) => ({ ...current, slug: undefined }));
          }}
        />
        {editing ? (
          <CheckboxRow
            label={t('active')}
            help={t('active-help')}
            checked={form.active}
            onChange={(event) => {
              const active = event.target.checked;
              setForm((current) => ({ ...current, active }));
            }}
          />
        ) : null}
      </form>
    </Dialog>
  );
}
