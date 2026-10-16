import { THEME_COOKIE, themeChoice } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'MondaPac Seller' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request headers makes every page dynamic, so the proxy's nonce reaches Next's
  // own scripts (ADR-0034 decision 6).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const messages = await getMessages();
  // A saved theme is set here; "system" is resolved by the head script before the first paint,
  // which changes the attribute React rendered, hence suppressHydrationWarning.
  const choice = themeChoice((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="en-AU"
      dir="ltr"
      data-theme-choice={choice}
      data-theme={choice === 'system' ? undefined : choice}
      suppressHydrationWarning
    >
      <head>
        {/* Blocking on purpose: it must set the theme before the first paint. */}
        <script nonce={nonce} src="/theme.js" />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
