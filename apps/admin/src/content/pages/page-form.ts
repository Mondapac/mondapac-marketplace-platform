import { SLUG_MAX, SLUG_PATTERN, TITLE_MAX, type DynamicTemplate } from './page-types.ts';

// The form of "New page": plain values, the checks the API makes (storefront `parseNewPage`), and
// the body it takes. The API stays the judge: these checks only save a round trip.

/** Slugs a dynamic page may not take (storefront `RESERVED_SLUGS`, apps/api storefront domain/templates.ts: keep the two in step), so `/l/<slug>` is never a system word. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'home',
  'offers',
  'express',
  'category',
  'search',
  'product',
  'sellers',
  'seller',
  'cart',
  'checkout',
  'order-confirmation',
  'account',
  'navigation',
  'admin',
  'api',
  'c',
  'p',
  's',
  'l',
  'login',
  'sign-in',
  'sign-up',
  'orders',
  'new',
  'preview',
  'draft',
]);

export type FormField = 'template' | 'title' | 'slug' | 'linkedId' | 'startsAt' | 'endsAt';
export type FieldCode =
  'required' | 'too-long' | 'format' | 'reserved' | 'taken' | 'before-start' | 'invalid';
export type FieldErrors = Partial<Record<FormField, FieldCode>>;

export interface NewPageForm {
  readonly template: DynamicTemplate | '';
  readonly title: string;
  readonly slug: string;
  /** True once the person typed in the slug field: the title no longer rewrites it. */
  readonly slugEdited: boolean;
  /** The category the page is linked to ('' none). */
  readonly linkedId: string;
  /** datetime-local values on the Market's clock; '' none. */
  readonly startsAt: string;
  readonly endsAt: string;
}

export const EMPTY_FORM: NewPageForm = {
  template: '',
  title: '',
  slug: '',
  slugEdited: false,
  linkedId: '',
  startsAt: '',
  endsAt: '',
};

/** A slug from a title: lower case, letters and digits, single hyphens, at most 80 characters. */
export function slugOf(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return base.slice(0, SLUG_MAX).replace(/-+$/u, '');
}

export function validate(form: NewPageForm): FieldErrors {
  const errors: { -readonly [K in FormField]?: FieldCode } = {};
  if (form.template === '') errors.template = 'required';
  const title = form.title.trim();
  if (title === '') errors.title = 'required';
  else if ([...title].length > TITLE_MAX) errors.title = 'too-long';
  if (form.slug === '') errors.slug = 'required';
  else if (form.slug.length > SLUG_MAX || !SLUG_PATTERN.test(form.slug)) errors.slug = 'format';
  else if (RESERVED_SLUGS.has(form.slug)) errors.slug = 'reserved';
  if (form.startsAt !== '' && form.endsAt !== '' && form.endsAt <= form.startsAt) {
    errors.endsAt = 'before-start';
  }
  return errors;
}

/** The API's field problems (`validation.failed` details) as form errors; the rest is `other`. */
export function mapProblems(
  problems: readonly { readonly path: string; readonly code: string }[],
): {
  readonly fields: FieldErrors;
  readonly other: readonly string[];
} {
  const fields: { -readonly [K in FormField]?: FieldCode } = {};
  const other: string[] = [];
  for (const { path, code } of problems) {
    const field: FormField | null =
      path === 'title'
        ? 'title'
        : path === 'slug'
          ? 'slug'
          : path === 'templateKey'
            ? 'template'
            : path === 'startsAt' || path === 'endsAt'
              ? path
              : path.startsWith('linked')
                ? 'linkedId'
                : null;
    if (field === null) {
      other.push(`${path}:${code}`);
      continue;
    }
    fields[field] =
      code === 'reserved'
        ? 'reserved'
        : code === 'required'
          ? 'required'
          : code === 'before-start'
            ? 'before-start'
            : code === 'format' && field === 'slug'
              ? 'format'
              : code === 'too-long' || code === 'max-length'
                ? 'too-long'
                : 'invalid';
  }
  return { fields, other };
}

/** The body of `POST storefront/admin/pages`; the live window is sent as instants. */
export function requestOf(
  form: NewPageForm,
  toInstant: (local: string) => string | null,
): Record<string, unknown> {
  return {
    templateKey: form.template,
    title: form.title.trim(),
    slug: form.slug,
    linked: form.linkedId === '' ? null : { type: 'category', id: form.linkedId },
    startsAt: form.startsAt === '' ? null : toInstant(form.startsAt),
    endsAt: form.endsAt === '' ? null : toInstant(form.endsAt),
  };
}

export const sameForm = (a: NewPageForm, b: NewPageForm): boolean =>
  a.template === b.template &&
  a.title === b.title &&
  a.slug === b.slug &&
  a.linkedId === b.linkedId &&
  a.startsAt === b.startsAt &&
  a.endsAt === b.endsAt;
