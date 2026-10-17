import { Temporal } from '@mondapac/shared-kernel';
import { at, closedObject, image, problem, text, uuid, type Problems } from './fields';
import {
  DYNAMIC_TEMPLATE_KEYS,
  LINKED_TYPES,
  RESERVED_SLUGS,
  templateOf,
  type LinkedType,
} from './templates';

// The settings of a page (content-management analysis 3): its title, its slug (a dynamic page's
// URL is `/l/<slug>`), its SEO fields, the entity it is linked to and its live window. A system
// page keeps its fixed key and URL: only its title and SEO fields change.

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const MAX_SLUG_LENGTH = 80;

export interface Seo {
  readonly title?: string;
  readonly description?: string;
  readonly image?: { readonly ref: string; readonly alt: string };
}

export interface Linked {
  readonly type: LinkedType;
  readonly id: string;
}

export interface DynamicSettings {
  readonly title: string;
  readonly slug: string;
  readonly seo: Seo;
  readonly linked: Linked | null;
  readonly startsAt: Temporal.Instant | null;
  readonly endsAt: Temporal.Instant | null;
}

export interface SystemSettings {
  readonly title: string;
  readonly seo: Seo;
}

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: Problems };

const result = <T>(problems: Problems, value: T): Parsed<T> =>
  problems.length === 0 ? { ok: true, value } : { ok: false, problems };

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && SLUG.test(value);
}

function slugOf(problems: Problems, value: unknown): string | null {
  if (!isSlug(value)) {
    problem(problems, 'slug', value === undefined ? 'required' : 'format');
    return null;
  }
  if (RESERVED_SLUGS.has(value)) {
    problem(problems, 'slug', 'reserved');
    return null;
  }
  return value;
}

function seoOf(problems: Problems, value: unknown): Seo {
  if (value === undefined || value === null) return {};
  if (!closedObject(problems, 'seo', value, ['title', 'description', 'image'])) return {};
  const title = text(problems, at('seo', 'title'), value.title, 70, true);
  const description = text(problems, at('seo', 'description'), value.description, 160, true);
  const shareImage = image(problems, at('seo', 'image'), value.image, true);
  return {
    ...(title !== null ? { title } : {}),
    ...(description !== null ? { description } : {}),
    ...(shareImage !== null ? { image: shareImage } : {}),
  };
}

function instantOf(problems: Problems, path: string, value: unknown): Temporal.Instant | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.length <= 40) {
    try {
      return Temporal.Instant.from(value);
    } catch {
      // Falls through to `format`.
    }
  }
  problem(problems, path, 'format');
  return null;
}

function linkedOf(
  problems: Problems,
  value: unknown,
  allowed: readonly LinkedType[],
): Linked | null {
  if (value === undefined || value === null) return null;
  if (!closedObject(problems, 'linked', value, ['type', 'id'])) return null;
  const type = value.type;
  if (typeof type !== 'string' || !(LINKED_TYPES as readonly string[]).includes(type)) {
    problem(problems, at('linked', 'type'), type === undefined ? 'required' : 'enum');
    return null;
  }
  if (!(allowed as readonly string[]).includes(type)) {
    problem(problems, at('linked', 'type'), 'not-allowed-for-template');
    return null;
  }
  const id = uuid(problems, at('linked', 'id'), value.id);
  return id === null ? null : { type: type as LinkedType, id };
}

const DYNAMIC_FIELDS = ['title', 'slug', 'seo', 'linked', 'startsAt', 'endsAt'];

function dynamicSettings(
  problems: Problems,
  body: Record<string, unknown>,
  templateKey: string,
): DynamicSettings {
  const title = text(problems, 'title', body.title, 120);
  const slug = slugOf(problems, body.slug);
  const seo = seoOf(problems, body.seo);
  const linked = linkedOf(problems, body.linked, templateOf(templateKey).linkable);
  const startsAt = instantOf(problems, 'startsAt', body.startsAt);
  const endsAt = instantOf(problems, 'endsAt', body.endsAt);
  if (startsAt !== null && endsAt !== null && Temporal.Instant.compare(startsAt, endsAt) >= 0) {
    problem(problems, 'endsAt', 'before-start');
  }
  return { title: title ?? '', slug: slug ?? '', seo, linked, startsAt, endsAt };
}

/** The body of "create a dynamic page": a template plus the page's settings. */
export function parseNewPage(
  body: unknown,
): Parsed<DynamicSettings & { readonly templateKey: string }> {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, ['templateKey', ...DYNAMIC_FIELDS])) {
    return { ok: false, problems };
  }
  const templateKey = body.templateKey;
  if (typeof templateKey !== 'string' || !DYNAMIC_TEMPLATE_KEYS.includes(templateKey)) {
    problem(problems, 'templateKey', templateKey === undefined ? 'required' : 'enum');
    return { ok: false, problems };
  }
  const settings = dynamicSettings(problems, body, templateKey);
  return result(problems, { ...settings, templateKey });
}

/** The body of "change a dynamic page's settings" (replaces them all). */
export function parseDynamicSettings(body: unknown, templateKey: string): Parsed<DynamicSettings> {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, DYNAMIC_FIELDS)) return { ok: false, problems };
  return result(problems, dynamicSettings(problems, body, templateKey));
}

/** The body of "change a system page's settings": its title and SEO fields only. */
export function parseSystemSettings(body: unknown): Parsed<SystemSettings> {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, ['title', 'seo'])) return { ok: false, problems };
  const title = text(problems, 'title', body.title, 120);
  const seo = seoOf(problems, body.seo);
  return result(problems, { title: title ?? '', seo });
}

/** Reads a stored `seo` value back; anything it does not recognise is left out. */
export function readSeo(stored: unknown): Seo {
  const problems: Problems = [];
  const seo = seoOf(problems, stored);
  return problems.length === 0 ? seo : {};
}

/** Where an archived page's URL now sends the buyer: a site path, or null for "gone". */
export function parseArchive(body: unknown): Parsed<{ readonly redirectTo: string | null }> {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, ['redirectTo'])) return { ok: false, problems };
  const value = body.redirectTo;
  if (value === undefined || value === null) return { ok: true, value: { redirectTo: null } };
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^\/(?!\/)[A-Za-z0-9/_.~-]*$/u.test(value) ||
    value.split('/').includes('..')
  ) {
    problem(problems, 'redirectTo', 'format');
  }
  return result(problems, { redirectTo: value as string });
}

/** Settings a draft holds until it is published (the page row keeps what buyers see). */
export type PendingSettings =
  ({ readonly kind: 'dynamic' } & DynamicSettings) | ({ readonly kind: 'system' } & SystemSettings);

/** The stored form of pending settings: the body that would set them, instants as strings. */
export function storedSettings(settings: PendingSettings): Record<string, unknown> {
  if (settings.kind === 'system') return { title: settings.title, seo: settings.seo };
  return {
    title: settings.title,
    slug: settings.slug,
    seo: settings.seo,
    linked: settings.linked,
    startsAt: settings.startsAt?.toString() ?? null,
    endsAt: settings.endsAt?.toString() ?? null,
  };
}

/** Reads stored pending settings back, re-checked as a request body; null when none or bad. */
export function parseStoredSettings(
  stored: unknown,
  page: { readonly kind: 'system' | 'dynamic'; readonly templateKey: string },
): PendingSettings | null {
  if (stored === null || stored === undefined) return null;
  if (page.kind === 'system') {
    const parsed = parseSystemSettings(stored);
    return parsed.ok ? { kind: 'system', ...parsed.value } : null;
  }
  const parsed = parseDynamicSettings(stored, page.templateKey);
  return parsed.ok ? { kind: 'dynamic', ...parsed.value } : null;
}
