// The storefront's Content-Security-Policy. The checkout takes card details in Stripe's fields
// (PCI DSS 4.0 6.4.3: only scripts the page means to run), and a buyer reaches it from the cart
// page, the cart drawer or the assistant without loading a new document, so the policy in force
// on the checkout is the one of the first page loaded: every page gets it. Scripts run only from
// this site with the request's nonce (Next.js puts it on its own scripts) or from Stripe; Stripe,
// the Google Fonts stylesheet and its font files are the only other origins. A new third-party
// script, frame or connection on any page needs its origin added here.

/** Paths whose responses are not documents (Next.js build files): no policy, no nonce. */
export function policyPath(pathname: string): boolean {
  return !pathname.startsWith('/_next/');
}

/** A fresh nonce for one response: 128 random bits, base64. */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

const STRIPE_SCRIPTS = 'https://js.stripe.com https://*.js.stripe.com';

/**
 * The policy for one response. `dev` adds what `next dev` needs (eval and the socket for its
 * refresh) and leaves out the upgrade to https, which a plain-http local site cannot follow.
 * Product images come from this site today; the image host of the real cart goes in `img-src`.
 */
export function storefrontCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${STRIPE_SCRIPTS}${dev ? " 'unsafe-eval'" : ''}`,
    // Stripe's Element and React set style attributes; no script can come through a style.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.stripe.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src 'self' https://api.stripe.com https://merchant-ui-api.stripe.com${dev ? ' ws:' : ''}`,
    `frame-src ${STRIPE_SCRIPTS} https://hooks.stripe.com`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
