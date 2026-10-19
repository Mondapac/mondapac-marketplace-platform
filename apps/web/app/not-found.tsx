import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

export default async function NotFound() {
  const t = await getTranslations('route');
  return (
    <div className="state">
      <h1>{t('not-found-title')}</h1>
      <p>{t('not-found-message')}</p>
      <Link className="btn" href="/">
        {t('home')}
      </Link>
    </div>
  );
}
