'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';

export const SOCIAL_PROVIDERS = ['google', 'apple'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
/** How a provider round trip ended: signed in, refused or failed, or closed by the buyer. */
export type SocialResult = 'signed-in' | 'failed' | 'cancelled';

/**
 * Sample: every provider signs in to the sample account after a short wait. The real one sends the
 * buyer to the API's provider start and back; it is wired when the server side ships.
 */
export function sampleSocialSignIn(): Promise<SocialResult> {
  return new Promise((resolve) => setTimeout(() => resolve('signed-in'), 600));
}

const legalLinks = {
  terms: (chunks: ReactNode) => <Link href="/terms">{chunks}</Link>,
  privacy: (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>,
};

/**
 * Continue with Google or Apple, above the email form of Log in and Create account. While one
 * provider is open both buttons wait; a failure says so and leaves the email form to use.
 */
export function SocialSignIn({
  start,
  onSignedIn,
  legal,
}: {
  readonly start: (provider: SocialProvider) => Promise<SocialResult>;
  readonly onSignedIn: () => void;
  /** The terms line for a new buyer; Create account has its own under the form. */
  readonly legal: boolean;
}) {
  const t = useTranslations('account.auth');
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [failed, setFailed] = useState<SocialProvider | null>(null);
  const name = (provider: SocialProvider) => t(`providers.${provider}`);
  const press = (provider: SocialProvider) => {
    if (busy) return;
    setBusy(provider);
    setFailed(null);
    void start(provider)
      .catch((): SocialResult => 'failed')
      .then((result) => {
        setBusy(null);
        if (result === 'signed-in') onSignedIn();
        else if (result === 'failed') setFailed(provider);
      });
  };
  return (
    <div className="ac-social">
      {SOCIAL_PROVIDERS.map((provider) => (
        // aria-disabled, not disabled: the pressed button keeps focus while it waits.
        <button
          key={provider}
          className={`ac-sbtn ${provider}`}
          type="button"
          aria-disabled={busy ? true : undefined}
          aria-busy={busy === provider || undefined}
          onClick={() => press(provider)}
        >
          {provider === 'google' ? <GoogleMark /> : <AppleMark />}
          <span>
            {busy === provider
              ? t('connecting', { provider: name(provider) })
              : t('continue-with', { provider: name(provider) })}
          </span>
        </button>
      ))}
      <span className="sr-only" role="status">
        {busy ? t('connecting', { provider: name(busy) }) : ''}
      </span>
      {legal ? <p className="legal">{t.rich('social-agree', legalLinks)}</p> : null}
      {failed ? (
        <p className="ac-note ac-warn" role="alert">
          <Icon name="info" />
          <span>{t('social-failed', { provider: name(failed) })}</span>
        </p>
      ) : null}
      <p className="ac-or">
        <span>{t('or')}</span>
      </p>
    </div>
  );
}

/** Google's four-colour G (its brand colours, required by Google's sign-in guidelines). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.6 12.3c0-.8-.1-1.6-.2-2.3H12v4.3h5.9a5 5 0 01-2.2 3.3v2.8h3.6c2.1-1.9 3.3-4.8 3.3-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0012 23z"
      />
      <path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 010-4.2V7H2.1a11 11 0 000 10z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 002.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z"
      />
    </svg>
  );
}

/** Apple's mark, drawn in the button's text colour. */
function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM13.9 5c.7-.8 1.2-2 1-3.2-1 .1-2.3.7-3 1.5-.7.8-1.2 2-1.1 3.1 1.2.1 2.4-.6 3.1-1.4z"
      />
    </svg>
  );
}
