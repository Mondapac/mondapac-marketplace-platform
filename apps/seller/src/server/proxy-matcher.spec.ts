import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.ts';

// Next reads the matcher from proxy.ts as a literal, so the test reads the same literal.
const source = readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8');
const matcher = new RegExp(`^${/source: '([^']+)'/.exec(source)?.[1]}$`);

describe('seller proxy matcher (Hassan M-599-1)', () => {
  it('leaves the BFF relay out, so Next never buffers its request body', () => {
    expect(matcher.test('/api/sellers/store-profile')).toBe(false);
    expect(matcher.test('/api/x')).toBe(false);
  });

  it('still covers pages, so the nonce and security headers are set', () => {
    for (const path of ['/', '/settings/store-profile', '/orders', '/session-ended']) {
      expect(matcher.test(path)).toBe(true);
    }
  });

  it('does not raise the proxy body limit', () => {
    expect(nextConfig).not.toHaveProperty('experimental.proxyClientMaxBodySize');
  });
});
