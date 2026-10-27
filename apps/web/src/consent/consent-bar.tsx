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
 * usable. Hidden on the cookie settings page, which asks the same question. On a phone (under
 * 700px) the CSS shows the compact form instead: a two-line summary with Cookie settings as an
 * inline link, and Accept and Reject side by side; the long text and the Settings button are
 * the tablet and desktop form.
 */
export function ConsentBar({ initial }: { readonly initial: Consent | null }) {
  const t = useTranslations('consent');
  const pathname = usePathname();
  // The layout passes the saved choice again after a save on the settings page.
  const [decided, setDecided] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  if (decided || initial !== null || pathname === '/cookies') return null;

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
        <p className="consent-long">{t('body')}</p>
        <p className="consent-short">
          {t.rich('short', {
            settings: (chunks) => <Link href="/cookies">{chunks}</Link>,
          })}
        </p>
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
