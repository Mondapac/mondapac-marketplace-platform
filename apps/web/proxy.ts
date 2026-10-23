import { NextResponse, type NextRequest } from 'next/server';
import { checkoutCsp, checkoutPath, makeNonce } from './src/security/checkout-csp.ts';
import { NOINDEX_HEADER, indexingOn } from './src/seo/indexing.ts';

/**
 * Adds `X-Robots-Tag: noindex, nofollow` to every response, files included, while indexing is off.
 * It runs per request, so the switch takes effect without a rebuild (next.config headers are fixed
 * at build). On the checkout pages it also sets their Content-Security-Policy with a fresh nonce:
 * on the request, where Next.js reads the nonce for its own scripts, and on the response.
 */
export function proxy(request?: NextRequest): NextResponse {
  let response: NextResponse;
  if (request && checkoutPath(request.nextUrl.pathname)) {
    const policy = checkoutCsp(makeNonce(), process.env.NODE_ENV === 'development');
    const headers = new Headers(request.headers);
    headers.set('content-security-policy', policy);
    response = NextResponse.next({ request: { headers } });
    response.headers.set('Content-Security-Policy', policy);
  } else response = NextResponse.next();
  if (!indexingOn()) response.headers.set(NOINDEX_HEADER.name, NOINDEX_HEADER.value);
  return response;
}
