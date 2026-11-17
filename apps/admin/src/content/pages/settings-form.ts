import { RESERVED_SLUGS } from './page-form.ts';
import {
  SLUG_MAX,
  SLUG_PATTERN,
  TITLE_MAX,
  type PageDetail,
  type PendingSettings,
  type Seo,
} from './page-types.ts';

// The form of a page's Settings tab: plain values, the checks the API makes (storefront
// `parseDynamicSettings`, `parseSystemSettings`) and the body it takes. The API stays the judge:
// these checks only save a round trip.

export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;

export type SettingsField =
  | 'title'
  | 'slug'
  | 'linkedId'
  | 'startsAt'
  | 'endsAt'
  | 'seoTitle'
  | 'seoDescription'
  | 'imageRef'
  | 'imageAlt';
export type SettingsCode =
  'required' | 'too-long' | 'format' | 'reserved' | 'taken' | 'before-start' | 'invalid';
export type SettingsErrors = Partial<Record<SettingsField, SettingsCode>>;

export interface SettingsForm {
  readonly title: string;
  readonly slug: string;
  /** The linked category ('' none). */
  readonly linkedId: string;
  /** datetime-local values on the Market's clock; '' none. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly image: { readonly ref: string; readonly alt: string };
}

const len = (value: string): number => [...value.trim()].length;

/** What the form starts from: the draft's pending settings, or else the page as buyers see it. */
export function sourceOf(page: PageDetail): PendingSettings {
  return (
    page.draft.settings ?? {
      title: page.title,
      seo: page.seo,
      ...(page.kind === 'dynamic'
        ? {
            slug: page.slug ?? '',
            linked: page.linked,
            startsAt: page.startsAt,
            endsAt: page.endsAt,
          }
        : {}),
    }
  );
}

export function formOf(page: PageDetail, toLocal: (instant: string) => string): SettingsForm {
  const source = sourceOf(page);
  const seo: Seo = source.seo;
  return {
    title: source.title,
    slug: source.slug ?? '',
    linkedId: source.linked?.type === 'category' ? source.linked.id : '',
    startsAt: source.startsAt == null ? '' : toLocal(source.startsAt),
    endsAt: source.endsAt == null ? '' : toLocal(source.endsAt),
    seoTitle: seo.title ?? '',
    seoDescription: seo.description ?? '',
    image: { ref: seo.image?.ref ?? '', alt: seo.image?.alt ?? '' },
  };
}

export const sameForm = (a: SettingsForm, b: SettingsForm): boolean =>
  a.title === b.title &&
  a.slug === b.slug &&
  a.linkedId === b.linkedId &&
  a.startsAt === b.startsAt &&
  a.endsAt === b.endsAt &&
  a.seoTitle === b.seoTitle &&
  a.seoDescription === b.seoDescription &&
  a.image.ref === b.image.ref &&
  a.image.alt === b.image.alt;

export function validate(form: SettingsForm, dynamic: boolean): SettingsErrors {
  const errors: { -readonly [K in SettingsField]?: SettingsCode } = {};
  if (form.title.trim() === '') errors.title = 'required';
  else if (len(form.title) > TITLE_MAX) errors.title = 'too-long';
  if (dynamic) {
    if (form.slug === '') errors.slug = 'required';
    else if (form.slug.length > SLUG_MAX || !SLUG_PATTERN.test(form.slug)) errors.slug = 'format';
    else if (RESERVED_SLUGS.has(form.slug)) errors.slug = 'reserved';
    if (form.startsAt !== '' && form.endsAt !== '' && form.endsAt <= form.startsAt) {
      errors.endsAt = 'before-start';
    }
  }
  if (len(form.seoTitle) > SEO_TITLE_MAX) errors.seoTitle = 'too-long';
  if (len(form.seoDescription) > SEO_DESCRIPTION_MAX) errors.seoDescription = 'too-long';
  if (form.image.ref !== '' && form.image.alt.trim() === '') errors.imageAlt = 'required';
  if (form.image.ref === '' && form.image.alt.trim() !== '') errors.imageRef = 'required';
  return errors;
}

/** The API's field problems (`validation.failed` details) as form errors; the rest is `other`. */
export function mapProblems(
  problems: readonly { readonly path: string; readonly code: string }[],
): { readonly fields: SettingsErrors; readonly other: readonly string[] } {
  const fields: { -readonly [K in SettingsField]?: SettingsCode } = {};
  const other: string[] = [];
  for (const { path, code } of problems) {
    const field: SettingsField | null =
      path === 'title' || path === 'slug' || path === 'startsAt' || path === 'endsAt'
        ? path
        : path === 'seo.title'
          ? 'seoTitle'
          : path === 'seo.description'
            ? 'seoDescription'
            : path === 'seo.image.ref' || path === 'seo.image'
              ? 'imageRef'
              : path === 'seo.image.alt'
                ? 'imageAlt'
                : path.startsWith('linked')
                  ? 'linkedId'
                  : null;
    if (field === null) {
      other.push(`${path}:${code}`);
      continue;
    }
    fields[field] =
      code === 'reserved' || code === 'required' || code === 'before-start'
        ? code
        : code === 'format' && field === 'slug'
          ? 'format'
          : code === 'length' || code === 'too-long' || code === 'max-length'
            ? 'too-long'
            : 'invalid';
  }
  return { fields, other };
}

/**
 * The body of `PUT storefront/admin/pages/:page`. A dynamic page replaces all its settings; a
 * system page sends its title and SEO only. A link to something other than a category (set
 * elsewhere) is sent back as it was.
 */
export function requestOf(
  form: SettingsForm,
  page: PageDetail,
  toInstant: (local: string) => string | null,
  toLocal: (instant: string) => string = () => '',
): Record<string, unknown> {
  // A time left as it was is sent as it was (the form drops the seconds).
  const own = sourceOf(page);
  const instant = (local: string, original: string | null | undefined) =>
    local === ''
      ? null
      : original != null && toLocal(original) === local
        ? original
        : toInstant(local);
  const seo: Record<string, unknown> = {};
  if (form.seoTitle.trim() !== '') seo.title = form.seoTitle.trim();
  if (form.seoDescription.trim() !== '') seo.description = form.seoDescription.trim();
  if (form.image.ref !== '') seo.image = { ref: form.image.ref, alt: form.image.alt.trim() };
  if (page.kind === 'system') return { title: form.title.trim(), seo };
  const kept = sourceOf(page).linked;
  const linked =
    form.linkedId !== ''
      ? { type: 'category', id: form.linkedId }
      : kept != null && kept.type !== 'category'
        ? kept
        : null;
  return {
    title: form.title.trim(),
    slug: form.slug,
    seo,
    linked,
    startsAt: instant(form.startsAt, own.startsAt),
    endsAt: instant(form.endsAt, own.endsAt),
  };
}
