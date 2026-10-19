import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/** An unknown seller: say so, rather than the shop-wide "not ready yet" page. */
export default async function SellerNotFound() {
  const t = await getTranslations('seller');
  return (
    <div className="state">
      <h1>{t('not-found-title')}</h1>
      <p>{t('not-found-message')}</p>
      <Link className="btn" href="/">
        {t('not-found-home')}
      </Link>
    </div>
  );
}
