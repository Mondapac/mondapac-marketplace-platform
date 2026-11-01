import type { SearchSelectOption } from '@mondapac/ui';
import type { ActivityField } from './activity-errors.ts';
import {
  CATEGORIES_MAX,
  CATEGORY_MAX_DEPTH,
  CODE_MAX,
  DESCRIPTION_MAX,
  NAME_MAX,
  type ActivityRow,
  type CategoryTree,
} from './types.ts';

// The activity form as state, the request body it makes and the checks that run before a request
// is sent (the API checks the same things and answers `validation.failed` with `details.fields`).

export interface NameRow {
  readonly locale: string;
  readonly name: string;
}

export interface ActivityFormState {
  /** One row per language; the default language is first and always there. */
  readonly names: readonly NameRow[];
  /** Empty while creating means: the API derives it from the default name. */
  readonly code: string;
  readonly description: string;
  readonly active: boolean;
  readonly categoryIds: readonly string[];
}

export const emptyForm = (defaultLocale: string): ActivityFormState => ({
  names: [{ locale: defaultLocale, name: '' }],
  code: '',
  description: '',
  active: true,
  categoryIds: [],
});

/** Rows of an existing activity: the default language first, the others in locale order. */
export const formOf = (row: ActivityRow, defaultLocale: string): ActivityFormState => {
  const others = Object.keys(row.names)
    .filter((locale) => locale !== defaultLocale)
    .sort();
  return {
    names: [defaultLocale, ...others].map((locale) => ({
      locale,
      name: row.names[locale] ?? '',
    })),
    code: row.code,
    description: row.description ?? '',
    active: row.status === 'active',
    categoryIds: row.categoryIds,
  };
};

const CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The code a name suggests (the same rule as the API): lower case ASCII words joined by hyphens. */
export function suggestCode(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, CODE_MAX)
    .replace(/-+$/gu, '');
  return words === '' ? 'activity' : words;
}

export interface FieldErrors {
  /** Message keys under `business-activities.form.error`, by locale. */
  readonly names?: Readonly<Record<string, string>>;
  readonly code?: string;
  readonly description?: string;
  readonly categoryIds?: string;
}

export const hasErrors = (errors: FieldErrors): boolean => Object.keys(errors).length > 0;

/** Message keys by field; empty when the form can be sent. A blank extra language is dropped. */
export function checkForm(
  form: ActivityFormState,
  defaultLocale: string,
  codeEditable: boolean,
): FieldErrors {
  const names: Record<string, string> = {};
  for (const row of form.names) {
    const name = row.name.trim();
    if (row.locale === defaultLocale && name === '') names[row.locale] = 'name-required';
    else if (name.length > NAME_MAX) names[row.locale] = 'name-long';
  }
  const errors: {
    names?: Record<string, string>;
    code?: string;
    description?: string;
    categoryIds?: string;
  } = {};
  if (Object.keys(names).length > 0) errors.names = names;
  const code = form.code.trim();
  if (codeEditable && code !== '' && (code.length > CODE_MAX || !CODE.test(code))) {
    errors.code = 'code-format';
  }
  if (form.description.trim().length > DESCRIPTION_MAX) errors.description = 'description-long';
  if (form.categoryIds.length > CATEGORIES_MAX) errors.categoryIds = 'categories-many';
  return errors;
}

/**
 * The body of create and edit. An edit replaces the whole content, so an empty description is
 * sent as null (cleared). The code is sent only while it can be set and was typed.
 */
export function bodyOf(form: ActivityFormState, codeEditable: boolean): Record<string, unknown> {
  const names: Record<string, string> = {};
  for (const row of form.names) {
    const name = row.name.trim();
    if (name !== '') names[row.locale] = name;
  }
  const description = form.description.trim();
  return {
    names,
    ...(codeEditable && form.code.trim() !== '' ? { code: form.code.trim() } : {}),
    description: description === '' ? null : description,
    categoryIds: [...form.categoryIds],
    status: form.active ? 'active' : 'inactive',
  };
}

/** The API's refused paths as form fields; an unknown path is dropped. */
export function fieldsOf(fields: readonly ActivityField[]): FieldErrors {
  const names: Record<string, string> = {};
  let rest: { code?: string; description?: string; categoryIds?: string } = {};
  for (const field of fields) {
    const why = field.code === 'claim-word' ? 'claim-word' : 'refused';
    if (field.path.startsWith('names.')) names[field.path.slice('names.'.length)] = why;
    else if (field.path === 'code')
      rest = { ...rest, code: field.code === 'taken' ? 'code-taken' : why };
    else if (field.path === 'description') rest = { ...rest, description: why };
    else if (field.path === 'categoryIds' || field.path.startsWith('categoryIds'))
      rest = { ...rest, categoryIds: 'categories-refused' };
  }
  return { ...(Object.keys(names).length > 0 ? { names } : {}), ...rest };
}

/**
 * The category picks: levels 1 and 2 of the public tree (depth first), each with its full path
 * ("Parent > Child") as the second line. Deeper levels are inherited, so they are not offered.
 */
export function categoryOptions(tree: CategoryTree): readonly SearchSelectOption[] {
  const trail: string[] = [];
  const out: SearchSelectOption[] = [];
  for (const node of tree.categories) {
    trail.length = node.depth;
    trail[node.depth] = node.name;
    if (node.depth > CATEGORY_MAX_DEPTH) continue;
    out.push({
      value: node.id,
      label: node.name,
      ...(node.depth === 0 ? {} : { description: trail.join(' > ') }),
    });
  }
  return out;
}

/** Display name of a language code in English; the code itself when unknown. */
export function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}
