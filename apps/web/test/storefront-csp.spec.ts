import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { proxy } from '../proxy.ts';
import { makeNonce, policyPath, storefrontCsp } from '../src/security/storefront-csp.ts';

const at = (path: string) => new NextRequest(`http://storefront.localhost:3003${path}`);

describe('storefront Content-Security-Policy', () => {
  it('covers every page, the ones a buyer leaves for the checkout included, but not build files', () => {
    for (const path of ['/', '/cart', '/p/brisket', '/checkout', '/checkout/payment'])
      expect(policyPath(path)).toBe(true);
    expect(policyPath('/_next/static/chunks/app.js')).toBe(false);
  });

  it('lets scripts run from this site with the nonce or from Stripe, and nothing frame the page', () => {
    const policy = storefrontCsp('abc123', false, null);
    expect(policy).toContain(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic' https://js.stripe.com https://*.js.stripe.com;",
    );
    expect(policy).toContain(
      'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com;',
    );
    expect(policy).toContain(
      "connect-src 'self' https://api.stripe.com https://merchant-ui-api.stripe.com;",
    );
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain('upgrade-insecure-requests');
    expect(policy).not.toContain('unsafe-eval');
    const dev = storefrontCsp('abc123', true, null);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain('upgrade-insecure-requests');
  });

  it('loads images only from this site and Stripe, and fonts from Google Fonts', () => {
    const policy = storefrontCsp('abc123', false, null);
    expect(policy).toContain("img-src 'self' data: blob: https://*.stripe.com;");
    expect(policy).not.toMatch(/img-src[^;]* https:(;| )/);
    expect(storefrontCsp('abc123', false, 'https://img.example.test')).toContain(
      "img-src 'self' data: blob: https://*.stripe.com https://img.example.test;",
    );
    // Fonts are self-hosted: no font host is allowed.
    expect(policy).toContain("style-src 'self' 'unsafe-inline';");
    expect(policy).toContain("font-src 'self' data:;");
    expect(policy).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('gives every response its own nonce, on the request for Next.js and on the response', () => {
    expect(makeNonce()).not.toBe(makeNonce());
    expect(makeNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    for (const path of ['/cart', '/checkout']) {
      const response = proxy(at(path));
      const policy = response.headers.get('Content-Security-Policy');
      expect(policy).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
      expect(proxy(at(path)).headers.get('Content-Security-Policy')).not.toBe(policy);
    }
    expect(proxy(at('/_next/static/chunks/app.js')).headers.has('Content-Security-Policy')).toBe(
      false,
    );
  });
});

describe('cache headers by language', () => {
  it('leaves the default (English only) response to the framework', () => {
    const response = proxy(at('/'));
    expect(response.headers.get('Cache-Control')).toBeNull();
  });

  it('makes documents private and uncacheable once a Market publishes another language', async () => {
    vi.resetModules();
    vi.doMock('../src/i18n/locale.ts', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      publishedLocales: () => ['en', 'fa'],
    }));
    const { proxy: multilingual } = await import('../proxy.ts');
    const page = multilingual(at('/'));
    expect(page.headers.get('Cache-Control')).toBe('private, no-store');
    // Build files stay cacheable.
    expect(multilingual(at('/_next/static/a.js')).headers.get('Cache-Control')).toBeNull();
    vi.doUnmock('../src/i18n/locale.ts');
  });
});
