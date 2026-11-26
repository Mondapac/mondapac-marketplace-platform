'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Icon } from '../icons/icon.tsx';

/**
 * A home section whose read failed: its heading when the layout names one, then a short notice
 * with Try again, so a fault never looks like an empty store. Try again re-renders the page on
 * the server (`router.refresh`), which reads the API again; the rest of the page stays as it is.
 */
export function SectionFailed({
  title,
  href,
}: {
  readonly title?: string;
  readonly href?: string;
}) {
  const t = useTranslations('home');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <section aria-label={title ?? t('section-failed-label')}>
      {title === undefined ? null : (
        <div className="sech">
          <h2>{title}</h2>
          {href === undefined ? null : (
            <Link href={href} aria-label={t('show-all-of', { title })}>
              {t('show-all')}
              <Icon name="chevr" />
            </Link>
          )}
        </div>
      )}
      <div className="empty sec-failed" role="status">
        <p>{t('section-failed')}</p>
        <button
          className="btn alt"
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
        >
          {pending ? t('section-retrying') : t('section-retry')}
        </button>
      </div>
    </section>
  );
}
