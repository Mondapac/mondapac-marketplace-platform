import { describe, expect, it } from 'vitest';
import { config } from './proxy.ts';

// The panel proxy sets the nonce and the security headers of PAGES. It must not run for the BFF
// relay: for each request it matches, Next buffers the body up to 10 MB and cuts the rest, which
// broke the 14.5 MB import upload and buffered bodies before authentication (Hassan I-585-5).

const matches = (path: string): boolean => {
  const source = config.matcher[0]?.source;
  if (source === undefined) throw new Error('no matcher');
  return new RegExp(`^${source}$`).test(path);
};

describe('proxy matcher', () => {
  it('covers pages', () => {
    for (const path of [
      '/',
      '/catalog/products',
      '/catalog/products/import',
      '/settings/delivery',
    ]) {
      expect(matches(path)).toBe(true);
    }
  });

  it('leaves the BFF relay and the static assets out', () => {
    for (const path of [
      '/api/catalog/admin/platform-imports',
      '/api/identity/admin/sign-in',
      '/_next/static/chunks/a.js',
      '/_next/image',
      '/favicon.ico',
    ]) {
      expect(matches(path)).toBe(false);
    }
  });
});
