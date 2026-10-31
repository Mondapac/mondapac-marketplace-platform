import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { BrowseCrumb } from '../../../src/catalog/browse-crumb.tsx';
import { FocusTitle } from '../../../src/errors/focus-title.tsx';

/** An unknown, draft or archived brand: one message for all of them (it never says which). */
export default function BrandNotFound() {
  const t = useTranslations('errors');
  const b = useTranslations('brands');
  return (
    <div className="er">
      <div className="er-box">
        <div className="er-code num" aria-hidden="true">
          404
        </div>
        <FocusTitle>{t('brand-not-found-title')}</FocusTitle>
        <p>{t('brand-not-found-message')}</p>
        <div className="er-act">
          <Link className="btn" href="/brands">
            {b('all-brands')}
          </Link>
          <BrowseCrumb className="btn ghost" label={t('browse')} />
        </div>
      </div>
    </div>
  );
}
