import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '../proxy.ts';
import { checkoutCsp, checkoutPath, makeNonce } from '../src/security/checkout-csp.ts';

const at = (path: string) => new NextRequest(`http://storefront.localhost:3003${path}`);

describe('checkout Content-Security-Policy', () => {
  it('covers the checkout pages only', () => {
    for (const path of ['/checkout', '/checkout/payment', '/checkout/confirmation'])
      expect(checkoutPath(path)).toBe(true);
    for (const path of ['/', '/cart', '/checkouts', '/p/checkout'])
      expect(checkoutPath(path)).toBe(false);
  });

  it('lets scripts run from this site with the nonce or from Stripe, and nothing frame the page', () => {
    const policy = checkoutCsp('abc123', false);
    expect(policy).toContain(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic' https://js.stripe.com;",
    );
    expect(policy).toContain('frame-src https://js.stripe.com https://hooks.stripe.com');
    expect(policy).toContain("connect-src 'self' https://api.stripe.com;");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('unsafe-eval');
    expect(checkoutCsp('abc123', true)).toContain("'unsafe-eval'");
  });

  it('gives every response its own nonce, on the request for Next.js and on the response', () => {
    expect(makeNonce()).not.toBe(makeNonce());
    expect(makeNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    const response = proxy(at('/checkout'));
    const policy = response.headers.get('Content-Security-Policy');
    expect(policy).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(proxy(at('/checkout')).headers.get('Content-Security-Policy')).not.toBe(policy);
    expect(proxy(at('/cart')).headers.has('Content-Security-Policy')).toBe(false);
  });
});
