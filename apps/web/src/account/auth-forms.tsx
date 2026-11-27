'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';
import { InviteSignUpLine } from '../invite/invite-ui.tsx';
import type { SignInOutcome } from '../shell/store-context.tsx';
import { SOCIAL_SIGN_IN_SHOWN } from '../storefront/features.ts';
import { resendVerification, signUp } from './customer-api.ts';
import { AcField, PasswordField } from './fields.tsx';
import { usePasswordRules } from './password-rules.ts';
import {
  SocialSignIn,
  sampleSocialSignIn,
  type SocialProvider,
  type SocialResult,
} from './social-sign-in.tsx';

const typed = (value: FormDataEntryValue | null): string =>
  typeof value === 'string' ? value : '';

/** `check`: "Check your email" after Create account, or after a log-in with an unconfirmed email. */
type Mode = 'login' | 'new' | 'forgot' | 'sent' | 'check';

/** Why Create account was refused, as the form words it. */
type SignUpProblem = 'throttled' | 'failed';

/** How the last "Send it again" ended. */
type Resend = 'idle' | 'pending' | 'sent' | 'throttled' | 'failed';

const legalLinks = {
  terms: (chunks: ReactNode) => <Link href="/terms">{chunks}</Link>,
  privacy: (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>,
};

/**
 * Log in, Create account and the forgot-password flow, shared by the log-in dialog and the log-in
 * page. `heading` draws the title (an h2 with a close button in the dialog, the page's h1).
 * Sample: any submit signs in to the sample account; the reset answer never says whether the email
 * has an account. Live (`signIn` given): Log in calls it and shows what went wrong; Create account
 * sends the email and password (`ux.md` A2, customer variant: no name) and shows "Check your
 * email" (A3) whatever the address, with "Send it again"; the mailed link opens
 * /account/confirm-email (A4). The password rule shown is the request Market's, read from the API.
 * A log-in with an unconfirmed email also leads to A3. Continue with Google or Apple shows only
 * with SOCIAL_SIGN_IN_SHOWN.
 */
export function AuthForms({
  heading,
  onSignedIn,
  social = SOCIAL_SIGN_IN_SHOWN,
  startSocial = sampleSocialSignIn,
  signIn,
  startMode = 'login',
}: {
  /** `new` opens on Create account (an invite link's button does). */
  readonly startMode?: 'login' | 'new';
  readonly heading: (title: string) => ReactNode;
  readonly onSignedIn: () => void;
  readonly social?: boolean;
  readonly startSocial?: (provider: SocialProvider) => Promise<SocialResult>;
  /** Live sign-in; absent in sample mode. */
  readonly signIn?: (email: string, password: string) => Promise<SignInOutcome>;
}) {
  const t = useTranslations('account.auth');
  const [mode, setMode] = useState<Mode>(startMode);
  // Live: a refused sign-in or sign-up, and a call in flight.
  const [problem, setProblem] = useState<SignInOutcome | null>(null);
  const [signUpProblem, setSignUpProblem] = useState<SignUpProblem | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [pending, setPending] = useState(false);
  // The address "Check your email" names and "Send it again" uses.
  const [checkEmail, setCheckEmail] = useState('');
  const [resend, setResend] = useState<Resend>('idle');
  const live = signIn !== undefined;
  const rules = usePasswordRules(live);
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
      ?.querySelector<HTMLElement>(mode === 'sent' || mode === 'check' ? '.btn' : 'input')
      ?.focus({ preventScroll: true });
  }, [mode]);

  return (
    <div className="ac-dc" ref={box}>
      {body()}
    </div>
  );

  function clearProblems() {
    setProblem(null);
    setSignUpProblem(null);
    setFieldErrors({});
  }

  function toCheck(email: string) {
    setCheckEmail(email);
    setResend('idle');
    clearProblems();
    setMode('check');
  }

  /** The words for a refused sign-up field; the value is never echoed. */
  function refusedFields(
    code: string,
    details: Readonly<Record<string, unknown>>,
    fields: readonly { path: string }[],
  ) {
    if (code === 'password.rejected') {
      const rule = details.rule;
      if (rule === 'common') return { password: t('sign-up.password-common') };
      if (rule === 'contains-identity') return { password: t('sign-up.password-identity') };
      return {
        password: rules
          ? t('sign-up.password-length', { min: rules.minLength, max: rules.maxLength })
          : t('sign-up.password-length-unknown'),
      };
    }
    if (code === 'validation.failed') {
      const paths = fields.map((field) => field.path);
      return {
        ...(paths.includes('email') ? { email: t('sign-up.email-invalid') } : {}),
        ...(paths.includes('password')
          ? {
              password: rules
                ? t('sign-up.password-length', { min: rules.minLength, max: rules.maxLength })
                : t('sign-up.password-length-unknown'),
            }
          : {}),
      };
    }
    return null;
  }

  function createAccount(email: string, password: string) {
    clearProblems();
    setPending(true);
    void signUp(email, password).then((result) => {
      setPending(false);
      if (result.kind === 'ok') return toCheck(email);
      if (result.kind === 'throttled') return setSignUpProblem('throttled');
      if (result.kind === 'invalid') {
        const fields = refusedFields(result.code, result.details, result.fields);
        if (fields && Object.keys(fields).length > 0) return setFieldErrors(fields);
      }
      setSignUpProblem('failed');
    });
  }

  function sendAgain() {
    setResend('pending');
    void resendVerification(checkEmail).then((result) => {
      setResend(
        result.kind === 'ok' ? 'sent' : result.kind === 'throttled' ? 'throttled' : 'failed',
      );
    });
  }

  function body() {
    if (mode === 'check')
      return (
        <>
          {heading(t('check.title'))}
          <div className="ac-note" role="status">
            <Icon name="check" />
            <span>{t('check.body', { email: checkEmail })}</span>
          </div>
          <p>{t('check.spam')}</p>
          <div className="ac-live" role="status">
            {resend === 'sent' ? (
              <p className="ac-note">
                <Icon name="check" />
                <span>{t('check.sent-again')}</span>
              </p>
            ) : null}
          </div>
          {resend === 'throttled' || resend === 'failed' ? (
            <p className="ac-note ac-warn" role="alert">
              <Icon name="info" />
              <span>{t(`check.resend-${resend}`)}</span>
            </p>
          ) : null}
          <div>
            <button
              className="btn ghost"
              type="button"
              disabled={resend === 'pending' || checkEmail === ''}
              onClick={sendAgain}
            >
              {t('check.send-again')}
            </button>
          </div>
          <button className="lnk" type="button" onClick={() => setMode('login')}>
            {t('back-to-log-in')}
          </button>
        </>
      );
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
              clearProblems();
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
              clearProblems();
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
            const data = new FormData(event.currentTarget);
            const email = typed(data.get('email')).trim();
            const password = typed(data.get('password'));
            if (!login) return createAccount(email, password);
            clearProblems();
            setPending(true);
            void signIn(email, password).then((outcome) => {
              setPending(false);
              if (outcome === 'ok') onSignedIn();
              // A3 with "Send it again": the address is confirmed before the first session.
              else if (outcome === 'unverified') toCheck(email);
              else setProblem(outcome);
            });
          }}
        >
          <AcField
            label={t('email')}
            name="email"
            type="email"
            autoComplete="email"
            required
            error={login ? undefined : fieldErrors.email}
          />
          <PasswordField
            label={t('password')}
            name="password"
            autoComplete={login ? 'current-password' : 'new-password'}
            hint={
              login || !rules
                ? undefined
                : t('password-hint', { min: rules.minLength, max: rules.maxLength })
            }
            error={login ? undefined : fieldErrors.password}
            // The browser checks the length too, counted in UTF-16 units: the API's count (code
            // points after NFKC) is the one that decides.
            minLength={login || !rules ? undefined : rules.minLength}
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
          {login ? null : <InviteSignUpLine />}
          {login && problem ? (
            <p className="ac-note ac-warn" role="alert">
              <Icon name="info" />
              <span>{t(`problem.${problem}`)}</span>
            </p>
          ) : null}
          {!login && signUpProblem ? (
            <p className="ac-note ac-warn" role="alert">
              <Icon name="info" />
              <span>{t(`sign-up.${signUpProblem}`)}</span>
            </p>
          ) : null}
          <button className="btn" type="submit" disabled={pending}>
            {login ? t('log-in') : pending ? t('sign-up.creating') : t('create-account')}
          </button>
        </form>
      </>
    );
  }
}
