// The Content-Security-Policy of the checkout pages, where Stripe's card fields take card details
// (PCI DSS 4.0 6.4.3: only scripts the page means to run). Scripts run only from this site with
// the request's nonce (Next.js puts it on its own scripts) or from js.stripe.com; Stripe's frames
// and API are the only other origins. The rest of the site has no policy yet.

/** The pages the policy covers: the checkout and the pages around Stripe's. */
export function checkoutPath(pathname: string): boolean {
  return pathname === '/checkout' || pathname.startsWith('/checkout/');
}

/** A fresh nonce for one response: 128 random bits, base64. */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The policy for one response. `dev` adds what `next dev` needs (eval for its refresh). */
export function checkoutCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com${dev ? " 'unsafe-eval'" : ''}`,
    // Stripe's Element and React set style attributes; no script can come through a style.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https://api.stripe.com${dev ? ' ws:' : ''}`,
    'frame-src https://js.stripe.com https://hooks.stripe.com',
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}
