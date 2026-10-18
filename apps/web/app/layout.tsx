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
import { StoreShell } from '../src/shell/store-shell.tsx';
import { loadStorefrontContent } from '../src/storefront/source.ts';
import './globals.css';

export async function generateMetadata() {
  const t = await getTranslations('store');
  return { title: t('title'), description: t('description') };
}

export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [messages, locale, jar, content] = await Promise.all([
    getMessages(),
    getLocale(),
    cookies(),
    loadStorefrontContent(),
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
          <StoreShell content={content} textSize={textSize}>
            {children}
          </StoreShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
