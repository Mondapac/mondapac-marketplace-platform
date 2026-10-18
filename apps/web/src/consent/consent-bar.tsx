'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Consent } from './consent.ts';
import { saveConsent } from './save-consent.ts';

/**
 * The first-visit cookie bar: Accept, Reject and Settings with equal weight. A labelled region
 * above the tab bar, not a dialog: it takes no focus, Escape does nothing, and the page stays
 * usable. Hidden on the cookie settings page, which asks the same question.
 */
export function ConsentBar({ initial }: { readonly initial: Consent | null }) {
  const t = useTranslations('consent');
  const pathname = usePathname();
  const [decided, setDecided] = useState(initial !== null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  if (decided || pathname === '/cookies') return null;

  const choose = (personalization: boolean) => {
    setFailed(false);
    startTransition(async () => {
      try {
        await saveConsent(personalization);
        setDecided(true);
      } catch {
        setFailed(true);
      }
    });
  };

  return (
    <section className="consent" aria-labelledby="consent-title">
      <div className="consent-text">
        <h2 id="consent-title">{t('title')}</h2>
        <p>{t('body')}</p>
        {failed ? (
          <p className="consent-error" role="alert">
            {t('error')}
          </p>
        ) : null}
      </div>
      <div className="consent-actions">
        <button className="btn" type="button" disabled={pending} onClick={() => choose(true)}>
          {t('accept')}
        </button>
        <button className="btn" type="button" disabled={pending} onClick={() => choose(false)}>
          {t('reject')}
        </button>
        <Link className="btn" href="/cookies">
          {t('settings')}
        </Link>
      </div>
    </section>
  );
}
