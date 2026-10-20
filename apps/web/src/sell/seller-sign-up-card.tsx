'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { AcField, PasswordField } from '../account/fields.tsx';
import { Icon } from '../icons/icon.tsx';
import type { SellerSignUpAnswer, SellerSignUpField } from '../storefront/types.ts';
import { resendSellerEmail, signUpSeller } from './actions.ts';
import {
  SIGN_UP_FIELDS,
  checkSignUp,
  minutesOf,
  type SellerSignUpErrors,
  type SellerSignUpInput,
} from './sign-up-rules.ts';

type Banner =
  { readonly kind: 'throttled'; readonly minutes: number } | { readonly kind: 'failed' };
type Resend =
  | { readonly kind: 'idle' | 'sending' | 'sent' | 'failed' }
  | { readonly kind: 'throttled'; readonly minutes: number };

const privacyLink = (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>;

/**
 * The sell page's form card (identity `ux.md` A2, then A3 "Check your email"). Name, email and
 * password only. Every accepted sign-up shows the same "Check your email", so the page never says
 * whether an address already has an account. Too many attempts disables the button for the wait
 * the API gives.
 */
export function SellerSignUpCard({
  passwordMin,
  passwordMax,
  signInUrl,
  submit = signUpSeller,
  resend = resendSellerEmail,
}: {
  readonly passwordMin: number;
  readonly passwordMax: number;
  readonly signInUrl: string;
  readonly submit?: (input: SellerSignUpInput) => Promise<SellerSignUpAnswer>;
  readonly resend?: (email: string) => Promise<SellerSignUpAnswer>;
}) {
  const t = useTranslations('sell');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<SellerSignUpErrors>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState<Resend>({ kind: 'idle' });
  const [pending, startTransition] = useTransition();
  const card = useRef<HTMLDivElement>(null);
  // What to focus once the next render is on screen: the first bad field, or a new step's title.
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    const selector = focusNext.current;
    if (selector === null) return;
    // The step may not be on screen yet in this commit; then the next one takes the focus.
    const target = card.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    focusNext.current = null;
    target.focus();
  });

  // The button stays off for the wait the API gave, then the banner goes.
  useEffect(() => {
    if (banner?.kind !== 'throttled') return;
    setBlocked(true);
    const timer = setTimeout(
      () => {
        setBlocked(false);
        setBanner(null);
      },
      banner.minutes * 60 * 1000,
    );
    return () => clearTimeout(timer);
  }, [banner]);

  const message = (field: SellerSignUpField): string | undefined => {
    const code = errors[field];
    if (code === undefined) return undefined;
    if (code === 'required') return t(`errors.${field}-required`);
    return t(`errors.${code}`, { min: passwordMin, max: passwordMax });
  };

  const showErrors = (found: SellerSignUpErrors) => {
    setErrors(found);
    const first = SIGN_UP_FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) focusNext.current = `[name="${first}"]`;
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || blocked) return;
    const input = { name, email, password };
    const found = checkSignUp(input, { min: passwordMin, max: passwordMax });
    setBanner(null);
    if (Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    setErrors({});
    startTransition(async () => {
      let answer: SellerSignUpAnswer;
      try {
        answer = await submit(input);
      } catch {
        answer = { kind: 'failed' };
      }
      switch (answer.kind) {
        case 'accepted':
          setSentTo(email.trim());
          setPassword('');
          setResent({ kind: 'idle' });
          focusNext.current = '.sg-mail h2';
          return;
        case 'invalid':
          showErrors(answer.fields);
          return;
        case 'throttled':
          setBanner({ kind: 'throttled', minutes: minutesOf(answer.retryAfterSeconds) });
          return;
        default:
          setBanner({ kind: 'failed' });
      }
    });
  };

  const onResend = () => {
    if (sentTo === null || resent.kind === 'sending') return;
    setResent({ kind: 'sending' });
    void (async () => {
      let answer: SellerSignUpAnswer;
      try {
        answer = await resend(sentTo);
      } catch {
        answer = { kind: 'failed' };
      }
      if (answer.kind === 'accepted') setResent({ kind: 'sent' });
      else if (answer.kind === 'throttled')
        setResent({ kind: 'throttled', minutes: minutesOf(answer.retryAfterSeconds) });
      else setResent({ kind: 'failed' });
    })();
  };

  const onWrongAddress = () => {
    setSentTo(null);
    setErrors({});
    setBanner(null);
    focusNext.current = '[name="email"]';
  };

  if (sentTo !== null)
    return (
      <div className="sg-card" ref={card}>
        <div className="sg-mail">
          <span className="big" aria-hidden="true">
            <Icon name="mail" />
          </span>
          <h2 tabIndex={-1}>{t('mail.title')}</h2>
          <p className="sub">
            {t.rich('mail.body', { email: sentTo, b: (chunks) => <b>{chunks}</b> })}
          </p>
          <p className="sg-note">{t('mail.wait')}</p>
          <div className="sg-row">
            <button
              className="sg-lk"
              type="button"
              onClick={onResend}
              disabled={resent.kind === 'sending'}
            >
              {resent.kind === 'sending' ? t('mail.sending') : t('mail.again')}
            </button>
            <button className="sg-lk" type="button" onClick={onWrongAddress}>
              {t('mail.wrong')}
            </button>
          </div>
          <div className="sg-st" role="status" aria-live="polite">
            {resent.kind === 'sent'
              ? t('mail.sent-again')
              : resent.kind === 'throttled'
                ? t('mail.again-throttled', { minutes: resent.minutes })
                : resent.kind === 'failed'
                  ? t('mail.again-failed')
                  : null}
          </div>
        </div>
        <hr className="sg-sep" />
        <p className="sg-note sg-center">
          <a href={signInUrl}>{t('mail.back')}</a>
        </p>
      </div>
    );

  return (
    <div className="sg-card" ref={card}>
      <form className="sg-form" noValidate onSubmit={onSubmit} aria-labelledby="sg-form-title">
        <h2 id="sg-form-title">{t('form.title')}</h2>
        <p className="sub">{t('form.sub')}</p>
        {banner === null ? null : (
          <div className={banner.kind === 'failed' ? 'sg-ban err' : 'sg-ban'} role="alert">
            <Icon name={banner.kind === 'failed' ? 'warn' : 'clock'} />
            <div>
              {banner.kind === 'failed'
                ? t('form.failed')
                : t('form.throttled', { minutes: banner.minutes })}
            </div>
          </div>
        )}
        <AcField
          label={t('form.name')}
          name="name"
          type="text"
          autoComplete="name"
          maxLength={200}
          value={name}
          onText={(value) => {
            setName(value);
            if (errors.name) setErrors({ ...errors, name: undefined });
          }}
          error={message('name')}
        />
        <AcField
          label={t('form.email')}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={320}
          value={email}
          onText={(value) => {
            setEmail(value);
            if (errors.email) setErrors({ ...errors, email: undefined });
          }}
          hint={t('form.email-hint')}
          error={message('email')}
        />
        <PasswordField
          label={t('form.password')}
          name="password"
          autoComplete="new-password"
          value={password}
          onText={(value) => {
            setPassword(value);
            if (errors.password) setErrors({ ...errors, password: undefined });
          }}
          hint={t('form.password-hint', { min: passwordMin, max: passwordMax })}
          error={message('password')}
        />
        <p className="sg-note">{t.rich('form.privacy-notice', { privacy: privacyLink })}</p>
        <button className="btn" type="submit" disabled={pending || blocked} aria-busy={pending}>
          {pending ? t('form.sending') : t('form.submit')}
        </button>
      </form>
      <hr className="sg-sep" />
      <p className="sg-note">
        {t.rich('form.have-account', { link: (chunks) => <a href={signInUrl}>{chunks}</a> })}
      </p>
      <p className="sg-note">{t('form.separate')}</p>
    </div>
  );
}
