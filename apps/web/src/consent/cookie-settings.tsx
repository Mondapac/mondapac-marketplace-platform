'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { Consent } from './consent.ts';
import { saveConsent } from './save-consent.ts';

/**
 * The optional switches of the cookie settings page, Personalization and (only where the Market
 * has a measurement ID) Analytics; Necessary cookies cannot be turned off.
 */
export function CookieSettings({
  initial,
  analyticsAvailable = false,
}: {
  readonly initial: Consent | null;
  readonly analyticsAvailable?: boolean;
}) {
  const t = useTranslations('cookies');
  const [on, setOn] = useState(initial?.personalization === true);
  const [measure, setMeasure] = useState(analyticsAvailable && initial?.analytics === true);
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [pending, startTransition] = useTransition();

  const save = () => {
    setStatus('idle');
    startTransition(async () => {
      try {
        await saveConsent(on, analyticsAvailable && measure);
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
      {analyticsAvailable ? (
        <label className="cookie-switch">
          <span className="cookie-switch-text">
            <b>{t('analytics')}</b>
            <span>{t('analytics-body')}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={measure}
            onChange={(event) => {
              setMeasure(event.currentTarget.checked);
              setStatus('idle');
            }}
          />
        </label>
      ) : null}
      <div className="cookie-save">
        <button className="btn" type="submit" disabled={pending}>
          {t('save')}
        </button>
        <p className={status === 'failed' ? 'consent-error' : 'cookie-status'} role="status">
          {status === 'saved' ? t('saved') : null}
          {status === 'failed' ? t('error') : null}
        </p>
      </div>
    </form>
  );
}
