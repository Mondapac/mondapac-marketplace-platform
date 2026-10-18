'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { Consent } from './consent.ts';
import { saveConsent } from './save-consent.ts';

/** The Personalization switch of the cookie settings page; Necessary cookies cannot be turned off. */
export function CookieSettings({ initial }: { readonly initial: Consent | null }) {
  const t = useTranslations('cookies');
  const [on, setOn] = useState(initial?.personalization === true);
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [pending, startTransition] = useTransition();

  const save = () => {
    setStatus('idle');
    startTransition(async () => {
      try {
        await saveConsent(on);
        setStatus('saved');
      } catch {
        setStatus('failed');
      }
    });
  };

  return (
    <form
      className="cookie-choice"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="cookie-switch">
        <span className="cookie-switch-text">
          <b>{t('personalization')}</b>
          <span>{t('personalization-body')}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={on}
          onChange={(event) => {
            setOn(event.currentTarget.checked);
            setStatus('idle');
          }}
        />
      </label>
      <div className="cookie-save">
        <button className="btn" type="submit" disabled={pending}>
          {t('save')}
        </button>
        <p className={status === 'failed' ? 'consent-error' : 'cookie-status'} role="status">
          {status === 'saved' ? t(on ? 'saved-on' : 'saved-off') : null}
          {status === 'failed' ? t('error') : null}
        </p>
      </div>
    </form>
  );
}
