import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { storefrontCsp } from '../src/security/storefront-csp.ts';

const request = vi.hoisted(() => ({
  host: 'storefront.localhost:3003',
  csp: null as string | null,
  consent: undefined as string | undefined,
  ga4: undefined as undefined | { id: string; nonce: string | null; enabled: boolean },
  shell: undefined as undefined | { analyticsAvailable?: boolean },
}));

vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve('en'),
  getMessages: () => Promise.resolve(messages),
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'sf-consent' && request.consent !== undefined
          ? { value: request.consent }
          : undefined,
    }),
  headers: () =>
    Promise.resolve(
      new Headers({
        host: request.host,
        ...(request.csp === null ? {} : { 'content-security-policy': request.csp }),
      }),
    ),
}));
vi.mock('../src/shell/store-shell.tsx', () => ({
  StoreShell: (props: { children: unknown; analyticsAvailable?: boolean }) => {
    request.shell = props;
    return props.children;
  },
}));
vi.mock('../src/analytics/ga4.tsx', () => ({
  Ga4: (props: { id: string; nonce: string | null; enabled: boolean }) => {
    request.ga4 = props;
    return null;
  },
}));
vi.mock('../src/storefront/source.ts', () => ({
  loadStorefrontContent: () => Promise.resolve({}),
  loadCartSource: () => Promise.resolve({}),
  loadLiveCart: () => Promise.resolve(null),
  loadCheckout: () => Promise.resolve({ customer: null }),
  loadAssistant: () => Promise.resolve({}),
  loadDeliveryLocator: () => Promise.resolve({}),
  storefrontIsLive: () => false,
}));
vi.mock('../src/storefront/photo-source.ts', () => ({
  photoBase: () => Promise.resolve(null),
}));

const { default: RootLayout } = await import('../app/layout.tsx');
const render = async () => renderToStaticMarkup(await RootLayout({ children: 'page' }));

beforeEach(() => {
  request.host = 'storefront.localhost:3003';
  request.csp = storefrontCsp('nonce123==', false, null, true);
  request.consent = undefined;
  request.ga4 = undefined;
  request.shell = undefined;
  vi.stubEnv('STOREFRONT_HOSTS', 'http://storefront.localhost:3003=AU');
  vi.stubEnv('STOREFRONT_GA4_IDS', 'AU=G-ABC123XYZ9');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('root layout analytics', () => {
  it('renders no tag and offers no analytics without an ID', async () => {
    vi.stubEnv('STOREFRONT_GA4_IDS', '');
    await render();
    expect(request.ga4).toBeUndefined();
    expect(request.shell?.analyticsAvailable).toBe(false);
  });

  it('renders no tag for an invalid ID', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('STOREFRONT_GA4_IDS', 'AU=UA-1234');
    await render();
    expect(request.ga4).toBeUndefined();
  });

  it.each([
    ['no choice yet', undefined],
    ['a v1 cookie', 'v1.p1'],
    ['Reject', 'v2.p0.a0'],
    ['Personalization alone', 'v2.p1.a0'],
  ])('has the tag off after %s', async (_name, consent) => {
    request.consent = consent;
    await render();
    expect(request.ga4).toMatchObject({ id: 'G-ABC123XYZ9', enabled: false });
    expect(request.shell?.analyticsAvailable).toBe(true);
  });

  it('has the tag on after Accept, with the nonce of the request', async () => {
    request.consent = 'v2.p1.a1';
    await render();
    expect(request.ga4).toEqual({ id: 'G-ABC123XYZ9', nonce: 'nonce123==', enabled: true });
  });
});
