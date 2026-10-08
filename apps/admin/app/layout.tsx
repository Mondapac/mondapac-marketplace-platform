import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'MondaPac Admin' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
