import type { TagField } from './tag-errors.ts';
import {
  INTRO_MAX,
  SLUG_MAX,
  SYNONYMS_MAX,
  TERM_MAX,
  TERM_MIN,
  type TopicGroup,
  type TopicRow,
} from './types.ts';

// The tag form as state, the request body it makes and the checks that run before a request is
// sent. The API checks the same things (and more: certification words, terms other tags use) and
// answers with `details.fields`, which `fieldsOf` puts back on the rows.

export interface SynonymRow {
  /** Stable while the row lives, for React keys and focus; never sent. */
  readonly key: number;
  readonly text: string;
}

export interface LanguageRow {
  readonly locale: string;
  readonly name: string;
  readonly synonyms: readonly SynonymRow[];
}

export interface TagFormState {
  /** One row per language; the default language is first and always there. */
  readonly languages: readonly LanguageRow[];
  readonly group: TopicGroup | '';
  readonly intro: string;
  /** Empty while creating means: the API derives it from the default name. */
  readonly slug: string;
  readonly active: boolean;
}

let nextKey = 1;
/** A fresh synonym row key. */
export const rowKey = (): number => nextKey++;

export const emptyForm = (defaultLocale: string): TagFormState => ({
  languages: [{ locale: defaultLocale, name: '', synonyms: [] }],
  group: '',
  intro: '',
  slug: '',
  active: true,
});

/** Rows of an existing tag: the default language first, the others in locale order. */
export const formOf = (row: TopicRow, defaultLocale: string): TagFormState => {
  const others = [...new Set([...Object.keys(row.names), ...Object.keys(row.synonyms)])]
    .filter((locale) => locale !== defaultLocale)
    .sort();
  return {
    languages: [defaultLocale, ...others].map((locale) => ({
      locale,
      name: row.names[locale] ?? '',
      synonyms: (row.synonyms[locale] ?? []).map((text) => ({ key: rowKey(), text })),
    })),
    group: row.group,
    intro: row.intro ?? '',
    slug: row.slug,
    active: row.status === 'active',
  };
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The slug a name suggests (the same rule as the API): lower case ASCII words joined by hyphens. */
export function suggestSlug(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/gu, '');
  return words === '' ? 'topic' : words;
}

/** A light fold for spotting repeats before sending; the API's normaliser is the real rule. */
const fold = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

/** The synonyms that are sent: typed rows only, trimmed, in order. */
const filled = (rows: readonly SynonymRow[]): readonly SynonymRow[] =>
  rows.filter((row) => row.text.trim() !== '');

export interface FieldErrors {
  /** Message keys under `tags.form.error`, by locale. */
  readonly names?: Readonly<Record<string, string>>;
  /** Message keys by synonym row key. */
  readonly synonyms?: Readonly<Record<number, string>>;
  /** A problem of a whole synonym list (too many, no name), by locale. */
  readonly synonymLists?: Readonly<Record<string, string>>;
  readonly group?: string;
  readonly intro?: string;
  readonly slug?: string;
}

export const hasErrors = (errors: FieldErrors): boolean =>
  [errors.group, errors.intro, errors.slug].some((value) => value !== undefined) ||
  [errors.names, errors.synonyms, errors.synonymLists].some(
    (map) => map !== undefined && Object.keys(map).length > 0,
  );

const termError = (text: string): string | undefined => {
  const length = text.trim().length;
  if (length < TERM_MIN) return 'short';
  if (length > TERM_MAX) return 'long';
  return undefined;
};

/** Message keys by field; empty when the form can be sent. A blank extra language is dropped. */
export function checkForm(
  form: TagFormState,
  defaultLocale: string,
  slugEditable: boolean,
): FieldErrors {
  const names: Record<string, string> = {};
  const synonyms: Record<number, string> = {};
  const synonymLists: Record<string, string> = {};
  for (const language of form.languages) {
    const name = language.name.trim();
    const rows = filled(language.synonyms);
    if (name === '') {
      if (language.locale === defaultLocale) names[language.locale] = 'name-required';
      else if (rows.length > 0) synonymLists[language.locale] = 'name-missing';
    } else {
      const problem = termError(name);
      if (problem !== undefined) names[language.locale] = problem;
    }
    if (rows.length > SYNONYMS_MAX) synonymLists[language.locale] = 'too-many';
    const seen = new Set(name === '' ? [] : [fold(name)]);
    for (const row of rows) {
      const problem = termError(row.text);
      const key = fold(row.text);
      if (problem !== undefined) synonyms[row.key] = problem;
      else if (seen.has(key)) synonyms[row.key] = 'duplicate';
      seen.add(key);
    }
  }
  const errors: {
    names?: Record<string, string>;
    synonyms?: Record<number, string>;
    synonymLists?: Record<string, string>;
    group?: string;
    intro?: string;
    slug?: string;
  } = {};
  if (Object.keys(names).length > 0) errors.names = names;
  if (Object.keys(synonyms).length > 0) errors.synonyms = synonyms;
  if (Object.keys(synonymLists).length > 0) errors.synonymLists = synonymLists;
  if (form.group === '') errors.group = 'group-required';
  if (form.intro.trim().length > INTRO_MAX) errors.intro = 'intro-long';
  const slug = form.slug.trim();
  if (slugEditable && slug !== '' && (slug.length > SLUG_MAX || !SLUG.test(slug))) {
    errors.slug = 'slug-format';
  }
  return errors;
}

/**
 * The body of create and edit. An edit replaces the whole content, so an empty intro is sent as
 * null (cleared). The slug is sent only while it can be set and was typed; the status only on
 * edit (a new tag is always active).
 */
export function bodyOf(form: TagFormState, editing: boolean): Record<string, unknown> {
  const names: Record<string, string> = {};
  const synonyms: Record<string, string[]> = {};
  for (const language of form.languages) {
    const name = language.name.trim();
    if (name !== '') names[language.locale] = name;
    const rows = filled(language.synonyms).map((row) => row.text.trim());
    if (rows.length > 0) synonyms[language.locale] = rows;
  }
  const intro = form.intro.trim();
  return {
    group: form.group,
    names,
    synonyms,
    intro: intro === '' ? null : intro,
    ...(!editing && form.slug.trim() !== '' ? { slug: form.slug.trim() } : {}),
    ...(editing ? { status: form.active ? 'active' : 'archived' } : {}),
  };
}

/** The message key for an API field code. */
function why(code: string, onSynonym: boolean): string {
  switch (code) {
    case 'required':
      return 'name-required';
    case 'too-short':
      return 'short';
    case 'too-long':
      return 'long';
    case 'taken':
      return onSynonym ? 'synonym-taken' : 'name-taken';
    case 'chars':
    case 'link':
    case 'duplicate':
    case 'claim-word':
    case 'locale-uncheckable':
    case 'too-many':
    case 'name-missing':
      return code;
    // `type` and `locale-unsupported` cannot come from this form (it sends strings and only the
    // Market's languages), so they fall to the plain refusal.
    default:
      return 'refused';
  }
}

/**
 * The API's refused paths as form fields. A synonym path `synonyms.<locale>.<n>` names the n-th
 * sent synonym, which is the n-th typed row of that language. An unknown path is dropped.
 */
export function fieldsOf(fields: readonly TagField[], form: TagFormState): FieldErrors {
  const names: Record<string, string> = {};
  const synonyms: Record<number, string> = {};
  const synonymLists: Record<string, string> = {};
  let rest: { group?: string; intro?: string; slug?: string } = {};
  for (const field of fields) {
    const [head, locale, index] = field.path.split('.');
    if (head === 'names' && locale !== undefined) names[locale] = why(field.code, false);
    else if (head === 'synonyms' && locale !== undefined) {
      const language = form.languages.find((row) => row.locale === locale);
      if (index === undefined) {
        synonymLists[locale] = why(field.code, true);
        continue;
      }
      const row = language === undefined ? undefined : filled(language.synonyms)[Number(index)];
      if (row !== undefined) synonyms[row.key] = why(field.code, true);
    } else if (head === 'group') rest = { ...rest, group: 'group-required' };
    else if (head === 'intro')
      rest = { ...rest, intro: field.code === 'too-long' ? 'intro-long' : why(field.code, false) };
    else if (head === 'slug')
      rest = {
        ...rest,
        slug:
          field.code === 'slug-taken'
            ? 'slug-taken'
            : field.code === 'format'
              ? 'slug-format'
              : why(field.code, false),
      };
  }
  return {
    ...(Object.keys(names).length > 0 ? { names } : {}),
    ...(Object.keys(synonyms).length > 0 ? { synonyms } : {}),
    ...(Object.keys(synonymLists).length > 0 ? { synonymLists } : {}),
    ...rest,
  };
}

export { languageName } from '../business-activities/activity-form.ts';
