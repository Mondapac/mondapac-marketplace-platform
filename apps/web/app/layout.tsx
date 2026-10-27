import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import {
  DEFAULT_PALETTE,
  PALETTE_COOKIE,
  TEXT_SIZE_COOKIE,
  paletteOf,
  textSizeOf,
} from '../src/preferences/preferences.ts';
import { CONSENT_COOKIE, consentOf } from '../src/consent/consent.ts';
import { scriptFontHref } from '../src/i18n/fonts.ts';
import { directionOf, languageTag } from '../src/i18n/locale.ts';
import { DELIVER_TO_COOKIE, deliverToOf } from '../src/delivery/deliver-to.ts';
import { RegisterServiceWorker } from '../src/pwa/register-service-worker.tsx';
import { ICONS, THEME_COLOR } from '../src/pwa/pwa-config.ts';
import { titleTemplate } from '../src/seo/defaults.ts';
import { indexingOn } from '../src/seo/indexing.ts';
import { StoreShell } from '../src/shell/store-shell.tsx';
import {
  loadAssistant,
  loadCartSource,
  loadLiveCart,
  loadCheckout,
  loadDeliveryLocator,
  loadStorefrontContent,
  storefrontIsLive,
} from '../src/storefront/source.ts';
import { photoBase } from '../src/storefront/photo-source.ts';
import './globals.css';
// After globals.css: the store pictures refine the logo tile and the banner it defines.
import '../src/seller/store-images.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('store');
  return {
    // A page that sets a plain title gets the store suffix; the pages' own helper sets it whole.
    title: { default: t('title'), template: titleTemplate(t('title')) },
    description: t('description'),
    // iOS home-screen install (the manifest covers the other browsers).
    appleWebApp: { capable: true, title: t('title'), statusBarStyle: 'default' },
    // Next emits only the unprefixed mobile-web-app-capable; older iOS reads the apple- one.
    other: { 'apple-mobile-web-app-capable': 'yes' },
    icons: { apple: [{ url: ICONS.apple, sizes: '180x180', type: 'image/png' }] },
    ...(indexingOn() ? {} : { robots: { index: false, follow: false } }),
  };
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: THEME_COLOR,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [
    messages,
    locale,
    jar,
    content,
    cartSource,
    liveCart,
    photos,
    checkout,
    assistant,
    locator,
  ] = await Promise.all([
    getMessages(),
    getLocale(),
    cookies(),
    loadStorefrontContent(),
    loadCartSource(),
    loadLiveCart(),
    photoBase(),
    loadCheckout(),
    loadAssistant(),
    loadDeliveryLocator(),
  ]);
  const lang = languageTag(locale);
  const scriptFont = scriptFontHref(lang);
  const palette = paletteOf(jar.get(PALETTE_COOKIE)?.value);
  const textSize = textSizeOf(jar.get(TEXT_SIZE_COOKIE)?.value);
  return (
    <html
      lang={lang}
      dir={directionOf(lang)}
      data-palette={palette === DEFAULT_PALETTE ? undefined : palette}
      data-text-size={textSize === 'auto' ? undefined : textSize}
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap"
        />
        {scriptFont === null ? null : <link rel="stylesheet" href={scriptFont} />}
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <StoreShell
            content={content}
            cartSource={cartSource}
            liveCart={liveCart}
            photoBase={photos}
            locator={locator}
            deliverTo={deliverToOf(jar.get(DELIVER_TO_COOKIE)?.value)}
            consent={consentOf(jar.get(CONSENT_COOKIE)?.value)}
            signIn={checkout.customer}
            live={storefrontIsLive()}
            assistant={assistant}
          >
            {children}
          </StoreShell>
        </NextIntlClientProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
