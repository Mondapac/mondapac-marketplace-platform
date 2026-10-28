import { problem } from './fields';
import type { Problems } from './fields';

// The slug of a post: lower-case words joined by hyphens, 3 to 80 characters, not one of the words
// that are routes under /blog. The database holds the same rules (posts_slug_check).

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
export const SLUG_MIN = 3;
export const SLUG_MAX = 80;
/** Routes under /blog: a post can never take one of these words as its slug. */
export const RESERVED_POST_SLUGS: readonly string[] = [
  'category',
  'tag',
  'events',
  'rss',
  'feed',
  'search',
  'page',
];

export const isValidSlug = (value: string): boolean =>
  value.length >= SLUG_MIN &&
  value.length <= SLUG_MAX &&
  SLUG_PATTERN.test(value) &&
  !RESERVED_POST_SLUGS.includes(value);

/** A slug an author typed: checked as it is, never corrected silently. */
export function parsePostSlug(problems: Problems, path: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    problem(problems, path, 'required');
    return null;
  }
  if (typeof value !== 'string') {
    problem(problems, path, 'type');
    return null;
  }
  const slug = value.trim();
  if (!isValidSlug(slug)) {
    problem(problems, path, slug.length < SLUG_MIN || slug.length > SLUG_MAX ? 'length' : 'format');
    return null;
  }
  return slug;
}

/**
 * A slug made from a title: accents folded, anything but letters and digits becomes a hyphen. The
 * empty string when nothing usable is left (a title of symbols, or in a script with no Latin
 * letters): the author then types one.
 */
export function slugFromTitle(title: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  let slug = folded.slice(0, SLUG_MAX).replace(/-+$/u, '');
  if (slug.length === SLUG_MAX && folded.length > SLUG_MAX) {
    const cut = slug.lastIndexOf('-');
    if (cut >= SLUG_MIN) slug = slug.slice(0, cut);
  }
  return isValidSlug(slug) ? slug : '';
}

/** `slug-2`, `slug-3`, ...: the candidate after `slug` was taken, kept inside the length limit. */
export function slugWithSuffix(slug: string, attempt: number): string {
  const suffix = `-${attempt}`;
  return `${slug.slice(0, SLUG_MAX - suffix.length).replace(/-+$/u, '')}${suffix}`;
}

/** The most suffixes tried before the author is asked to choose another slug. */
export const MAX_SLUG_ATTEMPTS = 20;
