import { ALIAS_MAX, ALT_MAX, NAME_MAX, SUMMARY_MAX, type BrandRow } from './types.ts';

// The brand form as state, the request body it makes and the checks that run before a request is
// sent (the API checks the same things and answers `validation.failed` with `details.fields`).

export interface BrandFormState {
  readonly name: string;
  readonly slug: string;
  readonly summary: string;
  readonly originCountry: string;
  readonly logoImageId: string;
  readonly logoAlt: string;
  readonly headerImageId: string;
}

export const EMPTY_FORM: BrandFormState = {
  name: '',
  slug: '',
  summary: '',
  originCountry: '',
  logoImageId: '',
  logoAlt: '',
  headerImageId: '',
};

export const formOf = (brand: BrandRow): BrandFormState => ({
  name: brand.name,
  slug: brand.slug,
  summary: brand.summary ?? '',
  originCountry: brand.originCountry ?? '',
  logoImageId: brand.logoImageId ?? '',
  logoAlt: brand.logoAlt ?? '',
  headerImageId: brand.headerImageId ?? '',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COUNTRY = /^[A-Za-z]{2}$/;

export type FieldName = keyof BrandFormState;
export type FieldErrors = Partial<Record<FieldName, string>>;

/** Message keys under `brands.form.error` by field; empty when the form can be sent. */
export function checkForm(form: BrandFormState, slugEditable: boolean): FieldErrors {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'name-required';
  else if (name.length > NAME_MAX) errors.name = 'name-long';
  if (slugEditable && form.slug.trim() !== '' && !SLUG.test(form.slug.trim())) {
    errors.slug = 'slug-format';
  }
  if (form.summary.trim().length > SUMMARY_MAX) errors.summary = 'summary-long';
  if (form.originCountry.trim() !== '' && !COUNTRY.test(form.originCountry.trim())) {
    errors.originCountry = 'country-format';
  }
  const logo = form.logoImageId.trim();
  if (logo !== '' && !UUID.test(logo)) errors.logoImageId = 'image-format';
  if (logo !== '' && form.logoAlt.trim() === '') errors.logoAlt = 'alt-required';
  if (logo === '' && form.logoAlt.trim() !== '') errors.logoAlt = 'alt-without-logo';
  if (form.logoAlt.trim().length > ALT_MAX) errors.logoAlt = 'alt-long';
  const header = form.headerImageId.trim();
  if (header !== '' && !UUID.test(header)) errors.headerImageId = 'image-format';
  return errors;
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * The body of create and edit. An edit replaces the whole content, so an empty field is sent as
 * null (cleared). The slug is sent only while it can change.
 */
export function bodyOf(form: BrandFormState, slugEditable: boolean): Record<string, unknown> {
  return {
    name: form.name.trim(),
    ...(slugEditable && form.slug.trim() !== '' ? { slug: form.slug.trim() } : {}),
    summary: orNull(form.summary),
    originCountry: orNull(form.originCountry)?.toUpperCase() ?? null,
    logoImageId: orNull(form.logoImageId),
    logoAlt: orNull(form.logoAlt),
    headerImageId: orNull(form.headerImageId),
  };
}

/** The API's refused paths as form fields; an unknown path is dropped. */
export function fieldsOf(paths: readonly string[]): FieldErrors {
  const out: Record<string, string> = {};
  for (const path of paths) {
    if (path in EMPTY_FORM) out[path] = 'refused';
  }
  return out;
}

/** Extra spellings typed one per line or separated by commas: trimmed, de-duplicated, capped. */
export function parseAliases(text: string): {
  readonly aliases: string[];
  readonly tooMany: boolean;
} {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const alias = part.trim();
    if (alias !== '') seen.add(alias);
  }
  const aliases = [...seen];
  return { aliases: aliases.slice(0, ALIAS_MAX), tooMany: aliases.length > ALIAS_MAX };
}
