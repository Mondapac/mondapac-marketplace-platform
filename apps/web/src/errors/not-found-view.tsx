import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { BrowseCrumb } from '../catalog/browse-crumb.tsx';
import { Icon } from '../icons/icon.tsx';
import type { Category } from '../storefront/types.ts';
import { FocusTitle } from './focus-title.tsx';

const TOP_CATEGORIES = 3;

/**
 * The 404 page (approved design errors-a-teal v1): search, home and Browse products, and quick
 * links to the main pages and the top categories. It never says why the page is missing.
 */
export function NotFoundView({ categories }: { readonly categories: readonly Category[] }) {
  const t = useTranslations('errors');
  return (
    <div className="er">
      <div className="er-box">
        <div className="er-code num" aria-hidden="true">
          404
        </div>
        <FocusTitle>{t('not-found-title')}</FocusTitle>
        <p>{t('not-found-message')}</p>
        <form className="er-search" role="search" action="/search">
          <Icon name="search" />
          <input
            type="search"
            name="q"
            aria-label={t('search-label')}
            placeholder={t('search-placeholder')}
          />
          <button className="go" type="submit" aria-label={t('search-go')}>
            <Icon name="search" />
          </button>
        </form>
        <div className="er-act">
          <Link className="btn" href="/">
            {t('home')}
          </Link>
          <BrowseCrumb className="btn ghost" label={t('browse')} />
        </div>
        <nav className="er-links" aria-label={t('quick-links')}>
          <Link href="/offers">{t('offers')}</Link>
          <Link href="/sellers">{t('sellers')}</Link>
          <Link href="/express">{t('express')}</Link>
          {categories.slice(0, TOP_CATEGORIES).map((c) => (
            <Link key={c.code} href={`/c/${c.code}`}>
              {c.shortName}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
