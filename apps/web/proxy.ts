import { NextResponse, type NextRequest } from 'next/server';
import { ga4IdFor } from './src/analytics/ga4-config.ts';
import { DEFAULT_LOCALE, publishedLocales } from './src/i18n/locale.ts';
import { makeNonce, policyPath, storefrontCsp } from './src/security/storefront-csp.ts';
import { NOINDEX_HEADER, indexingOn } from './src/seo/indexing.ts';
import { parseImageOrigin } from './src/storefront/photos.ts';

/**
 * Adds `X-Robots-Tag: noindex, nofollow` to every response, files included, while indexing is off.
 * It runs per request, so the switch takes effect without a rebuild (next.config headers are fixed
 * at build). On every page it also sets the Content-Security-Policy with a fresh nonce: on the
 * request, where Next.js reads the nonce for its own scripts, and on the response.
 *
 * A page in a language other than the default depends on who is signed in, so once a Market
 * publishes one, every document is `private, no-store`: the proxy cannot tell
 * which pages the signed-in language reaches, and no cache may serve one buyer's language to
 * another. With English alone the pages are already per-request (the layout reads cookies).
 */
/** The photo origin for `img-src`; start-up already refused a malformed one, so null here. */
function imageOrigin(): string | null {
  try {
    return parseImageOrigin(process.env.STOREFRONT_IMAGE_ORIGIN);
  } catch {
    return null;
  }
}

export function proxy(request?: NextRequest): NextResponse {
  let response: NextResponse;
  if (request && policyPath(request.nextUrl.pathname)) {
    const policy = storefrontCsp(
      makeNonce(),
      process.env.NODE_ENV === 'development',
      imageOrigin(),
      ga4IdFor(request.headers.get('host')) !== null,
    );
    const headers = new Headers(request.headers);
    headers.set('content-security-policy', policy);
    response = NextResponse.next({ request: { headers } });
    response.headers.set('Content-Security-Policy', policy);
    if (publishedLocales().some((locale) => locale !== DEFAULT_LOCALE)) {
      response.headers.set('Cache-Control', 'private, no-store');
    }
  } else response = NextResponse.next();
  if (!indexingOn()) response.headers.set(NOINDEX_HEADER.name, NOINDEX_HEADER.value);
  return response;
}
