'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';
import { AcField, PasswordField } from './fields.tsx';

type Mode = 'login' | 'new' | 'forgot' | 'sent';

const legalLinks = {
  terms: (chunks: ReactNode) => <Link href="/terms">{chunks}</Link>,
  privacy: (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>,
};

/**
 * Log in, Create account and the forgot-password flow, shared by the log-in dialog and the log-in
 * page. `heading` draws the title (an h2 with a close button in the dialog, the page's h1).
 * Sample: any submit signs in to the sample account until customer sessions are wired; the reset
 * answer never says whether the email has an account.
 */
export function AuthForms({
  heading,
  onSignedIn,
}: {
  readonly heading: (title: string) => ReactNode;
  readonly onSignedIn: () => void;
}) {
  const t = useTranslations('account.auth');
  const [mode, setMode] = useState<Mode>('login');
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const last = useRef<Mode>(mode);
  // A new step keeps the keyboard in place: focus goes to its first field (or its button). The
  // Log in and Create account switch keeps focus on the switch.
  useEffect(() => {
    const from = last.current;
    last.current = mode;
    const tabs = (m: Mode) => m === 'login' || m === 'new';
    if (from === mode || (tabs(from) && tabs(mode))) return;
    box.current
      ?.querySelector<HTMLElement>(mode === 'sent' ? '.btn' : 'input')
      ?.focus({ preventScroll: true });
  }, [mode]);

  return (
    <div className="ac-dc" ref={box}>
      {body()}
    </div>
  );

  function body() {
    if (mode === 'forgot' || mode === 'sent')
      return (
        <>
          {heading(t('reset-title'))}
          {mode === 'sent' ? (
            <>
              <div className="ac-note" role="status">
                <Icon name="check" />
                <span>{t('reset-sent')}</span>
              </div>
              <div>
                <button className="btn ghost" type="button" onClick={() => setMode('login')}>
                  {t('back-to-log-in')}
                </button>
              </div>
            </>
          ) : (
            <form
              className="ac-f"
              onSubmit={(event) => {
                event.preventDefault();
                setMode('sent');
              }}
            >
              <p>{t('reset-intro')}</p>
              <AcField label={t('email')} type="email" autoComplete="email" required />
              <div>
                <button className="btn" type="submit">
                  {t('send-link')}
                </button>
              </div>
              <button className="lnk" type="button" onClick={() => setMode('login')}>
                {t('back-to-log-in')}
              </button>
            </form>
          )}
        </>
      );

    const login = mode === 'login';
    return (
      <>
        {heading(login ? t('log-in') : t('create-title'))}
        <div className="ac-tabs" role="group" aria-label={t('tabs')}>
          <button
            type="button"
            aria-pressed={login}
            aria-controls={`${id}-form`}
            onClick={() => setMode('login')}
          >
            {t('log-in')}
          </button>
          <button
            type="button"
            aria-pressed={!login}
            aria-controls={`${id}-form`}
            onClick={() => setMode('new')}
          >
            {t('create-account')}
          </button>
        </div>
        <form
          className="ac-f"
          id={`${id}-form`}
          onSubmit={(event) => {
            event.preventDefault();
            onSignedIn();
          }}
        >
          {login ? null : <AcField label={t('full-name')} autoComplete="name" required />}
          <AcField label={t('email')} type="email" autoComplete="email" required />
          <PasswordField
            label={t('password')}
            autoComplete={login ? 'current-password' : 'new-password'}
            hint={login ? undefined : t('password-hint')}
            minLength={login ? undefined : 10}
            required
          />
          {login ? (
            <button className="lnk" type="button" onClick={() => setMode('forgot')}>
              {t('forgot')}
            </button>
          ) : (
            <p className="legal">{t.rich('agree', legalLinks)}</p>
          )}
          <div className="ac-note">
            <Icon name="info" />
            <span>{t('cart-kept')}</span>
          </div>
          <button className="btn" type="submit">
            {login ? t('log-in') : t('create-account')}
          </button>
        </form>
      </>
    );
  }
}
