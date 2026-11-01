import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { storefrontCsp } from '../src/security/storefront-csp.ts';

// The request's locale, as next-intl hands it to the layout (src/i18n/request.ts).
const request = vi.hoisted(() => ({ locale: 'en' }));

vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve(request.locale),
  getMessages: () => Promise.resolve(messages),
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('../src/shell/store-shell.tsx', () => ({
  StoreShell: ({ children }: { children: unknown }) => children,
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
const html = async () => renderToStaticMarkup(await RootLayout({ children: 'page' }));
afterEach(() => {
  request.locale = 'en';
});

describe('root layout language and direction', () => {
  it('renders English, left to right, with the brand fonts only, by default', async () => {
    const markup = await html();
    expect(markup).toMatch(/<html lang="en" dir="ltr"/);
    expect(markup).toMatch(/<html [^>]*class="figtree-var jakarta-var"/);
    expect(markup).not.toMatch(/vazirmatn|noto-arabic/);
  });

  it('renders the same page for the English locale as next-intl hands it over', async () => {
    request.locale = 'en-u-ca-gregory-nu-latn';
    expect(await html()).toMatch(/<html lang="en" dir="ltr"/);
  });

  it('renders right to left with the Persian font for fa', async () => {
    request.locale = 'fa-u-ca-gregory-nu-latn';
    const markup = await html();
    expect(markup).toMatch(/<html lang="fa" dir="rtl"/);
    expect(markup).toMatch(/<html [^>]*class="figtree-var jakarta-var vazirmatn-var"/);
  });

  it('renders right to left with the Arabic font for ar', async () => {
    request.locale = 'ar';
    const markup = await html();
    expect(markup).toMatch(/<html lang="ar" dir="rtl"/);
    expect(markup).toMatch(/<html [^>]*class="figtree-var jakarta-var noto-arabic-var"/);
  });

  it('asks no font from Google: no stylesheet, preconnect or font host in the page or the policy', async () => {
    for (const locale of ['en', 'fa', 'ar']) {
      request.locale = locale;
      const markup = await html();
      expect(markup).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(markup).not.toMatch(/rel="(stylesheet|preconnect)"/);
    }
    expect(storefrontCsp('n', false, null)).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });
});
