'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';
import type { SignInOutcome } from '../shell/store-context.tsx';
import { SOCIAL_SIGN_IN_SHOWN } from '../storefront/features.ts';
import { AcField, PasswordField } from './fields.tsx';
import {
  SocialSignIn,
  sampleSocialSignIn,
  type SocialProvider,
  type SocialResult,
} from './social-sign-in.tsx';

const typed = (value: FormDataEntryValue | null): string =>
  typeof value === 'string' ? value : '';

type Mode = 'login' | 'new' | 'forgot' | 'sent';

const legalLinks = {
  terms: (chunks: ReactNode) => <Link href="/terms">{chunks}</Link>,
  privacy: (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>,
};

/**
 * Log in, Create account and the forgot-password flow, shared by the log-in dialog and the log-in
 * page. `heading` draws the title (an h2 with a close button in the dialog, the page's h1).
 * Sample: any submit signs in to the sample account; the reset answer never says whether the email
 * has an account. Live (`signIn` given): Log in calls it and shows what went wrong; Create account
 * says it is coming, as sign-up is not wired. Continue with Google or Apple shows only
 * with SOCIAL_SIGN_IN_SHOWN.
 */
export function AuthForms({
  heading,
  onSignedIn,
  social = SOCIAL_SIGN_IN_SHOWN,
  startSocial = sampleSocialSignIn,
  signIn,
}: {
  readonly heading: (title: string) => ReactNode;
  readonly onSignedIn: () => void;
  readonly social?: boolean;
  readonly startSocial?: (provider: SocialProvider) => Promise<SocialResult>;
  /** Live sign-in; absent in sample mode. */
  readonly signIn?: (email: string, password: string) => Promise<SignInOutcome>;
}) {
  const t = useTranslations('account.auth');
  const [mode, setMode] = useState<Mode>('login');
  // Live: a refused sign-in or a sign-up that is not available yet, and a call in flight.
  const [problem, setProblem] = useState<SignInOutcome | 'sign-up' | null>(null);
  const [pending, setPending] = useState(false);
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
            onClick={() => {
              setMode('login');
              setProblem(null);
            }}
          >
            {t('log-in')}
          </button>
          <button
            type="button"
            aria-pressed={!login}
            aria-controls={`${id}-form`}
            onClick={() => {
              setMode('new');
              setProblem(null);
            }}
          >
            {t('create-account')}
          </button>
        </div>
        {social ? <SocialSignIn start={startSocial} onSignedIn={onSignedIn} legal={login} /> : null}
        <form
          className="ac-f"
          id={`${id}-form`}
          onSubmit={(event) => {
            event.preventDefault();
            if (!signIn) return onSignedIn();
            if (!login) return setProblem('sign-up');
            const data = new FormData(event.currentTarget);
            setProblem(null);
            setPending(true);
            void signIn(typed(data.get('email')), typed(data.get('password'))).then((outcome) => {
              setPending(false);
              if (outcome === 'ok') onSignedIn();
              else setProblem(outcome);
            });
          }}
        >
          {login ? null : <AcField label={t('full-name')} autoComplete="name" required />}
          <AcField label={t('email')} name="email" type="email" autoComplete="email" required />
          <PasswordField
            label={t('password')}
            name="password"
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
          {problem ? (
            <p className="ac-note ac-warn" role="alert">
              <Icon name="info" />
              <span>{t(`problem.${problem}`)}</span>
            </p>
          ) : null}
          <button className="btn" type="submit" disabled={pending}>
            {login ? t('log-in') : t('create-account')}
          </button>
        </form>
      </>
    );
  }
}
