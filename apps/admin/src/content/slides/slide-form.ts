import {
  ALT_MAX,
  BODY_MAX,
  CTA_MAX,
  DEFAULT_POSITION,
  DEFAULT_WINDOW_DAYS,
  IMAGE_KEYS,
  LINK_TYPES,
  NAME_MAX,
  SLIDE_KINDS,
  TITLE_MAX,
  type LinkType,
  type SlideContent,
  type SlideDetail,
  type SlideKind,
  type SlidePlacement,
  type SlideVersion,
} from './slide-types.ts';

// The Content tab as form state, the request body it makes and the checks that run before a
// request is sent (the API checks the same things and answers `validation.failed` with
// `details.fields`; those paths are mapped back onto the fields here).

export interface SlideFormState {
  readonly kind: SlideKind;
  readonly internalName: string;
  readonly title: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly linkType: LinkType | '';
  readonly linkId: string;
  readonly imageRef: string;
  readonly alt: string;
  /** The saved image was marked decorative: it needs no description while none is typed. */
  readonly decorative: boolean;
  readonly sponsored: boolean;
}

export const EMPTY_FORM: SlideFormState = {
  kind: 'promotion',
  internalName: '',
  title: '',
  body: '',
  ctaLabel: '',
  linkType: '',
  linkId: '',
  imageRef: '',
  alt: '',
  decorative: false,
  sponsored: false,
};

/** The version the editor shows: the draft when there is one, else the live version. */
export const currentVersion = (slide: SlideDetail): SlideVersion | null =>
  slide.draft ?? slide.live;

export function formOf(slide: SlideDetail): SlideFormState {
  const version = currentVersion(slide);
  const content = version?.content ?? null;
  return {
    kind: slide.kind,
    internalName: version?.internalName ?? slide.internalName,
    title: content?.title ?? '',
    body: content?.body ?? '',
    ctaLabel: content?.ctaLabel ?? '',
    linkType: content?.link?.type ?? '',
    linkId: content?.link?.id ?? '',
    imageRef: content?.image?.ref ?? '',
    alt: content?.image?.alt ?? '',
    decorative: content?.image?.decorative ?? false,
    sponsored: version?.sponsored ?? slide.sponsored,
  };
}

/** Characters as the API counts them (code points, after trimming). */
export const countOf = (value: string): number => Array.from(value.trim()).length;

export type FormField =
  | 'kind'
  | 'internalName'
  | 'title'
  | 'body'
  | 'ctaLabel'
  | 'linkType'
  | 'linkId'
  | 'imageRef'
  | 'alt';

/** The reason a field is refused: a code of the API's checks, or a check of this form. */
export type FieldCode =
  'required' | 'length' | 'format' | 'markup' | 'url' | 'needs-link' | 'not-empty' | 'invalid';

export type FieldErrors = Partial<Record<FormField, FieldCode>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SEARCH_CODE = /^[a-z][a-z0-9-]{0,31}$/u;
const MARKUP = /[<>]/u;

function textProblem(value: string, max: number, optional: boolean): FieldCode | null {
  const trimmed = value.trim();
  if (trimmed === '') return optional ? null : 'required';
  if (countOf(trimmed) > max) return 'length';
  if (MARKUP.test(trimmed)) return 'markup';
  return null;
}

/** The checks the API makes that need no data of the Market. Returns the first problem per field. */
export function validate(form: SlideFormState): FieldErrors {
  const errors: { -readonly [K in FormField]?: FieldCode } = {};
  const set = (field: FormField, code: FieldCode | null) => {
    if (code !== null) errors[field] = code;
  };
  set('internalName', textProblem(form.internalName, NAME_MAX, false));
  set('title', textProblem(form.title, TITLE_MAX, false));
  set('body', textProblem(form.body, BODY_MAX, true));
  set('ctaLabel', textProblem(form.ctaLabel, CTA_MAX, true));
  const hasLink = form.linkType !== '';
  if (hasLink) {
    const ok =
      form.linkType === 'search'
        ? SEARCH_CODE.test(form.linkId.trim())
        : UUID.test(form.linkId.trim());
    if (form.linkId.trim() === '') errors.linkId = 'required';
    else if (!ok) errors.linkId = 'format';
  } else if (form.kind === 'link') {
    errors.linkType = 'required';
  }
  if (form.ctaLabel.trim() !== '' && !hasLink && errors.ctaLabel === undefined) {
    errors.ctaLabel = 'needs-link';
  }
  if (form.imageRef !== '') {
    if (!(IMAGE_KEYS as readonly string[]).includes(form.imageRef)) errors.imageRef = 'format';
    const alt = form.alt.trim();
    if (alt === '' && !form.decorative) errors.alt = 'required';
    else if (alt !== '') set('alt', textProblem(alt, ALT_MAX, false));
  }
  return errors;
}

const API_PATHS: Readonly<Record<string, FormField>> = {
  kind: 'kind',
  internalName: 'internalName',
  'content.title': 'title',
  'content.body': 'body',
  'content.ctaLabel': 'ctaLabel',
  'content.link': 'linkType',
  'content.link.type': 'linkType',
  'content.link.id': 'linkId',
  'content.image': 'imageRef',
  'content.image.ref': 'imageRef',
  'content.image.alt': 'alt',
};

const API_CODES: Readonly<Record<string, FieldCode>> = {
  required: 'required',
  length: 'length',
  format: 'format',
  markup: 'markup',
  url: 'url',
  'needs-link': 'needs-link',
  'not-empty': 'not-empty',
};

export interface MappedProblems {
  readonly fields: FieldErrors;
  /** Problems of values this tab does not edit (the window and the positions), or unknown ones. */
  readonly other: readonly { readonly path: string; readonly code: string }[];
}

/** Puts the `details.fields` of a `validation.failed` answer onto the form's fields. */
export function mapProblems(
  problems: readonly { readonly path: string; readonly code: string }[],
): MappedProblems {
  const fields: { -readonly [K in FormField]?: FieldCode } = {};
  const other: { path: string; code: string }[] = [];
  for (const problem of problems) {
    const field = API_PATHS[problem.path];
    if (field === undefined) {
      other.push(problem);
    } else if (fields[field] === undefined) {
      fields[field] = API_CODES[problem.code] ?? 'invalid';
    }
  }
  return { fields, other };
}

const clean = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** What the Content tab does not edit and a save must send again unchanged (the whole draft). */
export interface Carried {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly pinned: boolean;
  readonly placements: readonly SlidePlacement[];
  readonly textPosition: 'start' | 'center' | 'end';
  readonly textTone: 'light' | 'dark';
}

/** A new slide: the default window and position, until "Where and when" can change them. */
export function defaultCarried(now: Date): Carried {
  const end = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    startsAt: now.toISOString(),
    endsAt: end.toISOString(),
    pinned: false,
    placements: [
      {
        position: DEFAULT_POSITION,
        scope: 'all',
        scopeId: null,
        includeSubcategories: false,
        sortOrder: 0,
        autoplay: false,
      },
    ],
    textPosition: 'start',
    textTone: 'light',
  };
}

export function carriedOf(slide: SlideDetail): Carried | null {
  const version = currentVersion(slide);
  if (version === null) return null;
  return {
    startsAt: version.startsAt,
    endsAt: version.endsAt,
    pinned: version.pinned,
    placements: version.placements,
    textPosition: version.content?.textPosition ?? 'start',
    textTone: version.content?.textTone ?? 'light',
  };
}

export function contentOf(form: SlideFormState, carried: Carried): SlideContent {
  const alt = clean(form.alt);
  return {
    title: form.title.trim(),
    ...(clean(form.body) === undefined ? {} : { body: clean(form.body)! }),
    ...(clean(form.ctaLabel) === undefined ? {} : { ctaLabel: clean(form.ctaLabel)! }),
    ...(form.imageRef === ''
      ? {}
      : {
          image: {
            ref: form.imageRef,
            alt: alt ?? '',
            decorative: form.decorative && alt === undefined,
          },
        }),
    textPosition: carried.textPosition,
    textTone: carried.textTone,
    ...(form.linkType === '' ? {} : { link: { type: form.linkType, id: form.linkId.trim() } }),
  };
}

/** The body of POST (with `kind`) and PUT (without): the whole draft. */
export function requestOf(form: SlideFormState, carried: Carried, create: boolean) {
  return {
    ...(create ? { kind: form.kind } : {}),
    internalName: form.internalName.trim(),
    content: contentOf(form, carried),
    startsAt: carried.startsAt,
    endsAt: carried.endsAt,
    pinned: carried.pinned,
    sponsored: form.sponsored,
    placements: carried.placements,
  };
}

export const sameForm = (a: SlideFormState, b: SlideFormState): boolean =>
  (Object.keys(a) as (keyof SlideFormState)[]).every((key) => a[key] === b[key]);

export const isKind = (value: string): value is SlideKind =>
  (SLIDE_KINDS as readonly string[]).includes(value);
export const isLinkType = (value: string): value is LinkType =>
  (LINK_TYPES as readonly string[]).includes(value);
