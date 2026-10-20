import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { BrowseCrumb } from '../catalog/browse-crumb.tsx';

/**
 * Shell links whose pages are not built yet (SEO plan, package 2). Each route answers 200 with a
 * short "coming soon" page that search engines are told not to index; its links are still followed.
 * Remove a route here and its page.tsx when the real page lands.
 */
export const COMING_SOON = {
  '/browse': 'browse',
  '/offers': 'offers',
  '/express': 'express',
  '/certified': 'certified',
  '/recipes': 'recipes',
  '/gift-cards': 'gift-cards',
  '/help': 'help',
  '/help/delivery': 'help-delivery',
  '/help/returns': 'help-returns',
  '/help/contact': 'help-contact',
  '/help/certificates': 'help-certificates',
  '/delivery-area': 'delivery-area',
  '/about': 'about',
  '/terms': 'terms',
  '/privacy': 'privacy',
  '/sell/guidelines': 'sell-guidelines',
} as const;

export type ComingSoonPage = (typeof COMING_SOON)[keyof typeof COMING_SOON];

export async function comingSoonMetadata(page: ComingSoonPage): Promise<Metadata> {
  const [store, t] = await Promise.all([getTranslations('store'), getTranslations('coming-soon')]);
  return {
    title: `${t(`pages.${page}`)} | ${store('title')}`,
    robots: { index: false, follow: true },
  };
}

export async function ComingSoon({ page }: { readonly page: ComingSoonPage }) {
  const t = await getTranslations('coming-soon');
  return (
    <div className="state">
      <h1>{t(`pages.${page}`)}</h1>
      <p>{t('message')}</p>
      <div className="actions">
        <Link className="btn" href="/">
          {t('home')}
        </Link>
        <BrowseCrumb className="btn ghost" label={t('browse')} />
      </div>
    </div>
  );
}
