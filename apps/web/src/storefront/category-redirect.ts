import type { ApiRead } from './api.ts';
import { CATEGORY_SLUG, categoryHref } from './links.ts';

// The buyer site's category redirects (categories C6), answered by the proxy before any page
// renders so the status is exactly 301 or 302 (a page can only answer 307 or 308). The API's
// `GET catalog/categories/resolve?slug=` says where a slug leads; this file only turns that into a
// path. The target is always a slug checked against the slug pattern and written with
// `categoryHref`, never a URL from the answer, so a redirect can never leave `/c/` on this site.

/** One read of `catalog/categories/resolve` for a slug (already checked as a slug). */
export type ResolveRead = (slug: string) => Promise<ApiRead<unknown>>;

export interface CategoryRedirect {
  /** A site path under `/c/`, with the request's query kept. */
  readonly location: string;
  readonly status: 301 | 302;
}

type Answer =
  | { readonly kind: 'category'; readonly slug: string }
  | { readonly kind: 'redirect'; readonly slug: string; readonly permanent: boolean }
  | { readonly kind: 'not-found' }
  /** The API is off, refused for another reason, or answered something unreadable. */
  | { readonly kind: 'unknown' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A path segment as text, or null when it is not valid percent-encoding. */
function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function answerOf(slug: string, read: ResolveRead): Promise<Answer> {
  const answer = await read(slug);
  if (answer.kind === 'failed' && answer.code === 'catalog.category-not-found') {
    return { kind: 'not-found' };
  }
  if (answer.kind !== 'ok' || !isRecord(answer.body)) return { kind: 'unknown' };
  const body = answer.body;
  if (typeof body.slug !== 'string' || !CATEGORY_SLUG.test(body.slug)) return { kind: 'unknown' };
  if (body.kind === 'category') return { kind: 'category', slug: body.slug };
  if (body.kind === 'redirect' && typeof body.permanent === 'boolean' && body.slug !== slug) {
    return { kind: 'redirect', slug: body.slug, permanent: body.permanent };
  }
  return { kind: 'unknown' };
}

/**
 * The redirect a `/c/...` path needs, or null to let the page answer (a live category, a 404, or
 * an API that did not answer, where the page decides from the tree or the sample).
 *
 * `/c/<slug>`: a retired, merged or archived slug answers 301 to where it leads, a hidden one 302.
 * `/c/<category>/<sub>` (the address before C6): the subcategory first, then the category; the
 * first one that names something answers 301 to it (302 if that leads through a hidden category).
 * Either way the request's query goes with the redirect.
 * Anything deeper, or a segment that is not a slug, is left to the page (a 404).
 */
export async function categoryRedirect(
  pathname: string,
  search: string,
  read: ResolveRead,
): Promise<CategoryRedirect | null> {
  const match = /^\/c\/([^/]+)(?:\/([^/]+))?$/u.exec(pathname);
  if (match === null) return null;
  const first = decoded(match[1]!);
  const second = match[2] === undefined ? undefined : decoded(match[2]);
  if (first === null || second === null) return null;
  const query = search.startsWith('?') && search.length > 1 ? search : '';
  if (second === undefined) {
    if (!CATEGORY_SLUG.test(first)) return null;
    const answer = await answerOf(first, read);
    return answer.kind === 'redirect'
      ? { location: categoryHref(answer.slug) + query, status: answer.permanent ? 301 : 302 }
      : null;
  }
  for (const candidate of [second, first]) {
    if (!CATEGORY_SLUG.test(candidate)) continue;
    const answer = await answerOf(candidate, read);
    if (answer.kind === 'category') {
      return { location: categoryHref(answer.slug) + query, status: 301 };
    }
    if (answer.kind === 'redirect') {
      return { location: categoryHref(answer.slug) + query, status: answer.permanent ? 301 : 302 };
    }
    // Unknown: the API did not answer; the page decides rather than guessing a target.
    if (answer.kind === 'unknown') return null;
  }
  return null;
}
