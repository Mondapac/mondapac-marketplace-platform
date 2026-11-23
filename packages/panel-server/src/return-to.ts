/**
 * The page to open after sign-in (`?next=`), so a deep link survives the trip through sign-in.
 *
 * Only a path of the panel's own origin is kept: anything that could leave the origin (a scheme,
 * `//host`, a backslash, a control character) or that leads back into the sign-in flow, the
 * relay or a route handler is dropped and the caller falls back to the home page. The value is
 * checked where it is written (the redirect to sign-in) and again where it is read (the sign-in
 * page), so a hand-made link gains nothing.
 */
export const RETURN_TO_PARAM = 'next';

/** Set by the proxy on every page request: the path and query the browser asked for. */
export const REQUESTED_PATH_HEADER = 'x-mp-requested-path';

const MAX_LENGTH = 512;
const BASE = 'http://panel.invalid';

/** Paths that are never a place to return to: the sign-in flow itself, the relay and handlers. */
const EXCLUDED = [
  '/sign-in',
  '/sign-up',
  '/second-factor',
  '/check-email',
  '/confirm-email',
  '/forgot-password',
  '/reset-password',
  '/accept-invitation',
  '/session-ended',
  '/api',
  '/_next',
];

export function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  // A backslash reads as a slash in browsers ("/\host"); control characters can split a header.
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const path = url.pathname;
  if (path === '/') return null;
  if (EXCLUDED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null;
  return `${path}${url.search}`;
}

/** `base` with `?next=` (or `&next=`) for a safe return path; `base` unchanged otherwise. */
export function withReturnTo(base: string, raw: unknown): string {
  const target = safeReturnTo(raw);
  if (target === null) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${RETURN_TO_PARAM}=${encodeURIComponent(target)}`;
}
