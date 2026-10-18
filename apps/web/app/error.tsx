'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

/** A page that failed to render. The error itself stays in the server log; the digest finds it. */
export default function RouteErrorPage({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  const t = useTranslations('route');
  return (
    <div className="state" role="alert">
      <h1>{t('error-title')}</h1>
      <p>{t('error-message')}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={reset}>
          {t('retry')}
        </button>
        <Link className="btn alt" href="/">
          {t('home')}
        </Link>
      </div>
      {error.digest ? (
        <small>
          {t('reference')}: {error.digest}
        </small>
      ) : null}
    </div>
  );
}
