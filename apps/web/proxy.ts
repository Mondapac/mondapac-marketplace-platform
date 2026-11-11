import { NextResponse, type NextRequest } from 'next/server';
import { ga4IdFor } from './src/analytics/ga4-config.ts';
import { DEFAULT_LOCALE, publishedLocales } from './src/i18n/locale.ts';
import { makeNonce, policyPath, storefrontCsp } from './src/security/storefront-csp.ts';
import { NOINDEX_HEADER, indexingOn } from './src/seo/indexing.ts';
import { PROXY_READ_TIMEOUT_MS, apiGetWith } from './src/storefront/api.ts';
import { categoryRedirect, type ResolveRead } from './src/storefront/category-redirect.ts';
import { storefrontApiConfig } from './src/storefront/config.ts';
import { productIsMissing, storeIsMissing, type MissRead } from './src/storefront/miss.ts';
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

/** The resolver read for this request: the API's answer for its host's Market. */
const resolverFor =
  (request: NextRequest): ResolveRead =>
  (slug) =>
    apiGetWith(
      storefrontApiConfig(),
      request.headers,
      `catalog/categories/resolve?slug=${encodeURIComponent(slug)}`,
    );

/**
 * A `/c/...` path that moved answers its 301 or 302 here (categories C6), before any page: an old
 * two-level address, a retired or merged slug, or a hidden category. Everything else goes on.
 */
export async function proxy(request?: NextRequest): Promise<NextResponse> {
  if (request && request.nextUrl.pathname.startsWith('/c/')) {
    const moved = await categoryRedirect(
      request.nextUrl.pathname,
      request.nextUrl.search,
      resolverFor(request),
    );
    if (moved !== null) {
      // A site-relative Location (built from a checked slug and the request's already-encoded
      // query), so the answer never depends on the host the server sees.
      const response = new NextResponse(null, {
        status: moved.status,
        headers: { location: moved.location },
      });
      if (!indexingOn()) response.headers.set(NOINDEX_HEADER.name, NOINDEX_HEADER.value);
      return response;
    }
  }
  const missing = request ? await missingRoute(request) : null;
  return pageResponse(request, missing);
}

/**
 * `/p/<segment>` or `/s/<slug>` that has no page: the path of the internal route that renders its
 * 404 body on the server (`app/missing`). A `notFound()` thrown by the page itself is sent by
 * Next 16 as an empty shell, filled in by the browser after hydration; a rewrite is not, so the
 * body is real HTML and the status is set here. Null for any other path, for a page that exists
 * and for a read that failed (the page then shows its own error state). A client's own request
 * for `/missing/...` goes to `/missing`, which has no page: the framework's 404.
 */
async function missingRoute(request: NextRequest): Promise<string | null> {
  // Only a page read can be a 404 page: a POST (a server action) goes on to the page untouched.
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = request.nextUrl.pathname;
  // A router prefetch never shows a 404 page: the navigation that follows asks again, so it costs
  // no API read here. (A client that sends the header itself only gets the page's own not-found.)
  if (
    request.headers.has('next-router-prefetch') ||
    request.headers.has('next-router-segment-prefetch')
  ) {
    return null;
  }
  // The proxy does not run again for the route it rewrites to, so a request for `/missing/...`
  // here came from a client: it gets the site's own 404 page, never a 200 "not found" page.
  if (path === '/missing' || path.startsWith('/missing/')) return '/missing';
  const product = /^\/p\/([^/]+)$/u.exec(path);
  const store = /^\/s\/([^/]+)$/u.exec(path);
  if (!product && !store) return null;
  const config = storefrontApiConfig();
  // A short time-out (a slow API leaves the decision to the page), and the answer is shared with
  // the page's own read through the page-read cache, so a page that exists costs one API read.
  const read: MissRead = (readPath, keep) =>
    apiGetWith<unknown>(config, request.headers, readPath, Date.now, {
      share: keep,
      timeoutMs: PROXY_READ_TIMEOUT_MS,
    });
  if (product && (await productIsMissing(product[1]!, read, config !== null)))
    return `/missing${path}`;
  if (store && (await storeIsMissing(store[1]!, read))) return `/missing${path}`;
  return null;
}

function pageResponse(request?: NextRequest, missing: string | null = null): NextResponse {
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
    if (missing === null) response = NextResponse.next({ request: { headers } });
    else {
      const target = request.nextUrl.clone();
      target.pathname = missing;
      response = NextResponse.rewrite(target, { request: { headers }, status: 404 });
    }
    response.headers.set('Content-Security-Policy', policy);
    if (publishedLocales().some((locale) => locale !== DEFAULT_LOCALE)) {
      response.headers.set('Cache-Control', 'private, no-store');
    }
  } else response = NextResponse.next();
  if (!indexingOn()) response.headers.set(NOINDEX_HEADER.name, NOINDEX_HEADER.value);
  return response;
}
