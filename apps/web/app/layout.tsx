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
import { DELIVER_TO_COOKIE, deliverToOf } from '../src/delivery/deliver-to.ts';
import { indexingOn } from '../src/seo/indexing.ts';
import { StoreShell } from '../src/shell/store-shell.tsx';
import {
  loadAssistant,
  loadCartSource,
  loadCheckout,
  loadDeliveryLocator,
  loadStorefrontContent,
} from '../src/storefront/source.ts';
import './globals.css';
// After globals.css: the store pictures refine the logo tile and the banner it defines.
import '../src/seller/store-images.css';

export async function generateMetadata() {
  const t = await getTranslations('store');
  return {
    title: t('title'),
    description: t('description'),
    ...(indexingOn() ? {} : { robots: { index: false, follow: false } }),
  };
}

export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [messages, locale, jar, content, cartSource, checkout, assistant, locator] =
    await Promise.all([
      getMessages(),
      getLocale(),
      cookies(),
      loadStorefrontContent(),
      loadCartSource(),
      loadCheckout(),
      loadAssistant(),
      loadDeliveryLocator(),
    ]);
  const palette = paletteOf(jar.get(PALETTE_COOKIE)?.value);
  const textSize = textSizeOf(jar.get(TEXT_SIZE_COOKIE)?.value);
  return (
    <html
      lang={locale}
      dir="ltr"
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
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <StoreShell
            content={content}
            cartSource={cartSource}
            locator={locator}
            deliverTo={deliverToOf(jar.get(DELIVER_TO_COOKIE)?.value)}
            consent={consentOf(jar.get(CONSENT_COOKIE)?.value)}
            signIn={checkout.customer}
            assistant={assistant}
          >
            {children}
          </StoreShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
