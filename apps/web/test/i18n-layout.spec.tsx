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
}));
vi.mock('../src/shell/store-shell.tsx', () => ({
  StoreShell: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/storefront/source.ts', () => ({
  loadStorefrontContent: () => Promise.resolve({}),
  loadCartSource: () => Promise.resolve({}),
  loadCheckout: () => Promise.resolve({ customer: null }),
  loadAssistant: () => Promise.resolve({}),
  loadDeliveryLocator: () => Promise.resolve({}),
  storefrontIsLive: () => false,
}));

const { default: RootLayout } = await import('../app/layout.tsx');
const html = async () => renderToStaticMarkup(await RootLayout({ children: 'page' }));
const sheets = (markup: string) =>
  [...markup.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);

afterEach(() => {
  request.locale = 'en';
});

describe('root layout language and direction', () => {
  it('renders English, left to right, with the brand fonts only, by default', async () => {
    const markup = await html();
    expect(markup).toMatch(/<html lang="en" dir="ltr"/);
    expect(sheets(markup)).toHaveLength(1);
    expect(sheets(markup)[0]).toContain('family=Figtree');
    expect(markup).not.toMatch(/Vazirmatn|Noto\+Sans\+Arabic/);
  });

  it('renders the same page for the English locale as next-intl hands it over', async () => {
    request.locale = 'en-u-ca-gregory-nu-latn';
    expect(await html()).toMatch(/<html lang="en" dir="ltr"/);
  });

  it('renders right to left with the Persian font for fa', async () => {
    request.locale = 'fa-u-ca-gregory-nu-latn';
    const markup = await html();
    expect(markup).toMatch(/<html lang="fa" dir="rtl"/);
    expect(sheets(markup)).toHaveLength(2);
    expect(sheets(markup)[1]).toContain('family=Vazirmatn');
  });

  it('renders right to left with the Arabic font for ar', async () => {
    request.locale = 'ar';
    const markup = await html();
    expect(markup).toMatch(/<html lang="ar" dir="rtl"/);
    expect(sheets(markup)[1]).toContain('Noto+Sans+Arabic');
  });

  it('is allowed by the Content-Security-Policy for the font hosts', () => {
    const policy = storefrontCsp('n', false, null);
    expect(policy).toContain('https://fonts.googleapis.com');
    expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com");
  });
});
