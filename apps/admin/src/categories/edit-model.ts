import {
  KEYWORDS_MAX,
  KEYWORD_MAX,
  NAME_MAX,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  SHORT_DESCRIPTION_MAX,
  SLUG_MAX,
  SLUG_MIN,
  type EditDetails,
} from './types.ts';

// The pure part of the category editor: the form, its checks, the request bodies and the Google
// preview. The API checks everything again (including the claim-word check); these checks only
// save a round trip and put the message next to the field.

export interface LocaleForm {
  readonly name: string;
  readonly shortDescription: string;
  /** One text: keywords separated by commas or new lines. */
  readonly keywords: string;
}

export interface EditForm {
  readonly texts: Readonly<Record<string, LocaleForm>>;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly noindex: boolean;
  readonly showInMenu: boolean;
}

/** Field problems by path (`texts.fa.name`, `seo.title`, `slug`) to a message code. */
export type FieldErrors = Readonly<Record<string, string>>;

const EMPTY_LOCALE: LocaleForm = { name: '', shortDescription: '', keywords: '' };
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Same rule as the API (apps/api category-edit.ts): the search words are English, so a letter of
// any script but Latin is refused. Digits, punctuation and spaces pass.
const NON_ENGLISH = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

export const localeOf = (form: EditForm, locale: string): LocaleForm =>
  form.texts[locale] ?? EMPTY_LOCALE;

export function emptyForm(): EditForm {
  return { texts: {}, seoTitle: '', seoDescription: '', noindex: false, showInMenu: true };
}

export function formOf(details: EditDetails): EditForm {
  return {
    texts: Object.fromEntries(
      details.texts.map((entry) => [
        entry.locale,
        {
          name: entry.name,
          shortDescription: entry.shortDescription ?? '',
          keywords: entry.keywords.join(', '),
        },
      ]),
    ),
    seoTitle: details.seo.title ?? '',
    seoDescription: details.seo.description ?? '',
    noindex: details.seo.noindex,
    showInMenu: details.showInMenu,
  };
}

export function withLocale(form: EditForm, locale: string, change: Partial<LocaleForm>): EditForm {
  return { ...form, texts: { ...form.texts, [locale]: { ...localeOf(form, locale), ...change } } };
}

/** Keywords as typed: split on commas and new lines, trimmed, without empties or repeats. */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const word = part.trim();
    const key = word.toLocaleLowerCase();
    if (word === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/** A locale counts as filled when anything is typed in it. */
export function isTouched(entry: LocaleForm): boolean {
  return (
    entry.name.trim() !== '' || entry.shortDescription.trim() !== '' || entry.keywords.trim() !== ''
  );
}

/** The locales with no name yet, among `locales`. */
export function missingIn(form: EditForm, locales: readonly string[]): readonly string[] {
  return locales.filter((locale) => localeOf(form, locale).name.trim() === '');
}

export interface TextsBody {
  readonly [locale: string]: {
    readonly name: string;
    readonly shortDescription: string | null;
    readonly keywords: string[];
  };
}

/** The `texts` of a request: only the locales that have something typed (the rest are Missing). */
export function textsBody(form: EditForm): TextsBody {
  const out: Record<string, TextsBody[string]> = {};
  for (const [locale, entry] of Object.entries(form.texts)) {
    if (!isTouched(entry)) continue;
    out[locale] = {
      name: entry.name.trim(),
      shortDescription: entry.shortDescription.trim() === '' ? null : entry.shortDescription.trim(),
      keywords: parseKeywords(entry.keywords),
    };
  }
  return out;
}

export function seoBody(form: EditForm) {
  const clean = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  return {
    title: clean(form.seoTitle),
    description: clean(form.seoDescription),
    noindex: form.noindex,
  };
}

export function editBody(form: EditForm) {
  return { texts: textsBody(form), seo: seoBody(form), showInMenu: form.showInMenu };
}

/** The checks the form can make alone. Required locales must have a name. */
export function checkForm(form: EditForm, required: readonly string[]): FieldErrors {
  const errors: Record<string, string> = {};
  for (const [locale, entry] of Object.entries(form.texts)) {
    const base = `texts.${locale}`;
    const touched = isTouched(entry);
    if (touched && entry.name.trim() === '') errors[`${base}.name`] = 'required';
    if (entry.name.trim().length > NAME_MAX) errors[`${base}.name`] = 'format';
    if (entry.shortDescription.trim().length > SHORT_DESCRIPTION_MAX)
      errors[`${base}.shortDescription`] = 'format';
    const words = parseKeywords(entry.keywords);
    if (words.length > KEYWORDS_MAX || words.some((word) => word.length > KEYWORD_MAX))
      errors[`${base}.keywords`] = 'format';
  }
  for (const locale of required) {
    if (localeOf(form, locale).name.trim() === '') errors[`texts.${locale}.name`] = 'required';
  }
  if (form.seoTitle.trim().length > SEO_TITLE_MAX) errors['seo.title'] = 'format';
  if (form.seoDescription.trim().length > SEO_DESCRIPTION_MAX) errors['seo.description'] = 'format';
  if (NON_ENGLISH.test(form.seoTitle)) errors['seo.title'] = 'english-only';
  if (NON_ENGLISH.test(form.seoDescription)) errors['seo.description'] = 'english-only';
  return errors;
}

export const isSlug = (value: string): boolean =>
  value.length >= SLUG_MIN && value.length <= SLUG_MAX && SLUG.test(value);

/** A URL name suggested from an English name: lower case words with hyphens. */
export function suggestSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}

export function checkSlug(value: string): string | undefined {
  if (value === '') return 'required';
  return isSlug(value) ? undefined : 'format';
}

export interface Preview {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

/** How the page may look in a search result: text is cut the way a result cuts it. */
export function googlePreview(input: {
  readonly host: string;
  readonly slug: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly name: string;
  readonly shortDescription: string;
}): Preview {
  const cut = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
  const title = input.seoTitle.trim() === '' ? input.name.trim() : input.seoTitle.trim();
  const description =
    input.seoDescription.trim() === ''
      ? input.shortDescription.trim()
      : input.seoDescription.trim();
  return {
    title: cut(title === '' ? input.slug : title, SEO_TITLE_MAX),
    url: `${input.host}/c/${input.slug}`,
    description: cut(description, SEO_DESCRIPTION_MAX),
  };
}
