import { describe, expect, it, vi } from 'vitest';
import manifest from '../app/manifest.ts';
import { mayRegister } from '../src/pwa/register-service-worker.tsx';
import { storefrontCsp } from '../src/security/storefront-csp.ts';
import { PALETTE_SWATCHES } from '../src/preferences/preferences.ts';
import messages from '../messages/en.json' with { type: 'json' };

vi.mock('next-intl/server', () => ({
  getTranslations: () =>
    Promise.resolve((key: string) => (messages.store as Record<string, string>)[key]),
}));

describe('web app manifest', () => {
  it('names the app from the store title and is standalone at the site root', async () => {
    const m = await manifest();
    expect(m.name).toBe(messages.store.title);
    expect(m.short_name).toBe(messages.store.title);
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.theme_color).toBe(PALETTE_SWATCHES.B[0]);
    expect(m.background_color).toBe('#ffffff');
  });

  it('lists 192, 512 and 512 maskable icons and the 180 touch icon', async () => {
    const icons = (await manifest()).icons ?? [];
    const find = (sizes: string, purpose?: string) =>
      icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    expect(find('192x192')?.src).toBe('/icons/icon-192.png');
    expect(find('512x512')?.src).toBe('/icons/icon-512.png');
    expect(find('512x512', 'maskable')?.src).toBe('/icons/icon-512-maskable.png');
    expect(find('180x180')?.src).toBe('/icons/apple-touch-icon.png');
  });
});

describe('service worker registration', () => {
  const base = {
    production: true,
    protocol: 'https:',
    hostname: 'shop.example.test',
    supported: true,
  };
  it('registers in production over https or on localhost', () => {
    expect(mayRegister(base)).toBe(true);
    expect(mayRegister({ ...base, protocol: 'http:', hostname: 'localhost' })).toBe(true);
  });
  it('is skipped outside production, over plain http elsewhere, or without the API', () => {
    expect(mayRegister({ ...base, production: false })).toBe(false);
    expect(mayRegister({ ...base, protocol: 'http:' })).toBe(false);
    expect(mayRegister({ ...base, supported: false })).toBe(false);
  });
});

describe('CSP for the worker and manifest', () => {
  it('allows a worker and a manifest from this site only, in dev and production', () => {
    for (const dev of [false, true]) {
      const policy = storefrontCsp('n', dev, null);
      expect(policy).toContain("worker-src 'self';");
      expect(policy).toContain("manifest-src 'self';");
    }
  });
});
