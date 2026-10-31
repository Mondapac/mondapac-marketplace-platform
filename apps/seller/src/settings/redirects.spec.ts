import { describe, expect, it } from 'vitest';
import { settingsRedirects } from '../../next.config.ts';

function target(path: string): string | undefined {
  return settingsRedirects.find((redirect) => redirect.source === path)?.destination;
}

describe('seller settings redirects', () => {
  it('are all permanent', () => {
    expect(settingsRedirects.length).toBe(4);
    expect(settingsRedirects.every((redirect) => redirect.permanent)).toBe(true);
  });

  it('moves each old settings page to its new address', () => {
    expect(target('/store-profile')).toBe('/settings/store-profile');
    expect(target('/stock-locations')).toBe('/settings/stock-locations');
    expect(target('/payout-account')).toBe('/settings/payout-account');
    expect(target('/team')).toBe('/settings/team');
  });

  it('leaves the hub, the new pages, the offer stock page and the account pages alone', () => {
    for (const path of [
      '/settings',
      '/settings/store-profile',
      '/settings/team',
      '/offers/abc/stock',
      '/account/security',
      '/orders',
    ]) {
      expect(target(path), path).toBeUndefined();
    }
  });

  it('never points a redirect at another redirect (no chains)', () => {
    for (const redirect of settingsRedirects) {
      expect(target(redirect.destination), redirect.source).toBeUndefined();
    }
  });
});
