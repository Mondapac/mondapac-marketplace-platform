import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'MondaPac Admin' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request headers makes every page dynamic, so the proxy's nonce reaches Next's
  // own scripts (ADR-0034 decision 6).
  await headers();
  const messages = await getMessages();
  return (
    <html lang="en-AU" dir="ltr">
      <body>
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
