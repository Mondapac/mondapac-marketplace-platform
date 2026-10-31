import { describe, expect, it } from 'vitest';
import { settingsRedirects } from '../../next.config.ts';

// Next's `:path*` (zero or more segments) is the only pattern the redirects use.
function target(path: string): string | undefined {
  for (const redirect of settingsRedirects) {
    const pattern = new RegExp(`^${redirect.source.replace('/:path*', '(?:/(.*))?')}$`);
    const hit = pattern.exec(path);
    if (hit === null) continue;
    const rest = hit[1] === undefined ? '' : `/${hit[1]}`;
    return redirect.destination.replace('/:path*', rest);
  }
  return undefined;
}

describe('settings redirects', () => {
  it('are all permanent', () => {
    expect(settingsRedirects.length).toBeGreaterThan(0);
    expect(settingsRedirects.every((redirect) => redirect.permanent)).toBe(true);
  });

  it('moves each old settings page to its new address', () => {
    expect(target('/delivery-settings')).toBe('/settings/delivery');
    expect(target('/fleet-selection')).toBe('/settings/fleets');
    expect(target('/wallet')).toBe('/settings/wallet');
    expect(target('/team')).toBe('/settings/admins');
    expect(target('/roles')).toBe('/settings/roles');
    expect(target('/roles/new')).toBe('/settings/roles/new');
    expect(target('/roles/0190a000-0000-7000-8000-0000000000a1')).toBe(
      '/settings/roles/0190a000-0000-7000-8000-0000000000a1',
    );
  });

  it('leaves the wallet credit pages, the hub and the new pages alone', () => {
    for (const path of [
      '/wallet/credits',
      '/wallet/credit-requests',
      '/settings',
      '/settings/support',
      '/settings/assistant',
      '/settings/roles',
      '/orders',
    ]) {
      expect(target(path), path).toBeUndefined();
    }
  });

  it('never points a redirect at another redirect (no chains)', () => {
    for (const redirect of settingsRedirects) {
      expect(target(redirect.destination.replace(':path*', 'x')), redirect.source).toBeUndefined();
    }
  });
});
