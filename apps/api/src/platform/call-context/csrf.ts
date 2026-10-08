import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Population } from '@mondapac/shared-kernel';

/** The request header that carries the CSRF token of a cookie session (identity design 6.4). */
export const CSRF_HEADER = 'x-csrf-token';

/** The fixed label the CSRF token is computed over (identity design 6.4). */
const CSRF_LABEL = 'mondapac.csrf.v1';

/** Methods that change nothing (RFC 9110 9.2.1); every other method is unsafe. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether a request method is unsafe, so the origin and CSRF checks apply (identity 6.4). */
export function isUnsafeMethod(method: string | undefined): boolean {
  return !SAFE_METHODS.has((method ?? '').toUpperCase());
}

/**
 * The CSRF token of a cookie session (identity design 6.4, accepted by Hassan, 14.2):
 * HMAC-SHA-256 of a fixed label keyed with the session token, base64url. Nothing is stored and
 * no port is called: the guard computes it from the cookie it already holds. The page reads it
 * from the actor-summary answer; a page of another origin can read neither that answer nor the
 * `HttpOnly` cookie.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_LABEL).digest('base64url');
}

/** Whether the presented header equals the session's CSRF token, compared in constant time. */
export function csrfTokenMatches(sessionToken: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Whether an unsafe request to a population's routes must carry both origin headers (Ali's
 * ruling of 2026-10-08; Hassan): the admin and seller panels are reached only through their BFF
 * (ADR-0034 decision 3), which always sends `Origin` and `Sec-Fetch-Site`, so a request without
 * them is refused. Customer routes keep accepting a client that sends neither until the
 * storefront and mobile clients are decided. A security floor in code, never in Market config.
 */
export const ORIGIN_HEADERS_REQUIRED: Readonly<Record<Population, boolean>> = Object.freeze({
  admin: true,
  seller: true,
  customer: false,
});

/**
 * The origin checks of HF14 (identity design 6.4), for every request with an unsafe method to a
 * route of `population`, with or without a session: refused when `Sec-Fetch-Site` is present and
 * is not `same-origin`, or when `Origin` is present and is not on `allowedOrigins`, the route
 * population's own list. For admin and seller routes a missing header is refused too
 * ({@link ORIGIN_HEADERS_REQUIRED}); on a customer route a client that sends neither header (a
 * non-browser client) passes this check, and a cookie session still needs its CSRF token.
 */
export function originRefused(
  headers: IncomingHttpHeaders,
  population: Population,
  allowedOrigins: readonly string[],
): boolean {
  const fetchSite = headers['sec-fetch-site'];
  const origin = headers.origin;
  if (ORIGIN_HEADERS_REQUIRED[population] && (fetchSite === undefined || origin === undefined)) {
    return true;
  }
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return true;
  if (origin !== undefined && !allowedOrigins.includes(origin)) return true;
  return false;
}
