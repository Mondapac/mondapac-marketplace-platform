import type { ReactNode } from 'react';
import { noindexMetadata } from '../../src/seo/metadata.ts';

// Every /account page stays out of the index, whatever the page itself sets (SEO plan, package 1).
export const generateMetadata = noindexMetadata;

export default function AccountRootLayout({ children }: { children: ReactNode }) {
  return children;
}
