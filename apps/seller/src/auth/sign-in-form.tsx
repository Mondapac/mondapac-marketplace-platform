'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { fieldErrorKeys, formErrorKey } from './messages-for-errors.ts';
import { rememberEmail } from './pending-email.ts';
import { useThrottle } from './use-throttle.ts';

export type SignInNotice = 'session-ended' | 'signed-out' | 'password-changed' | null;

export function SignInForm({ notice }: { readonly notice: SignInNotice }) {
  const t = useTranslations('identity');
  const router = useRouter();
  const throttle = useThrottle();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<{
    key: string;
    values?: Record<string, string | number>;
  } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [throttled, setThrottled] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    setThrottled(false);
    const result = await callApi<{ code: 'signed-in' }>('POST', 'identity/seller/sign-in', {
      email: email.trim(),
      password,
      keepSignedIn,
    });
    if (result.ok) {
      router.replace('/');
      router.refresh();
      return;
    }
    setPending(false);
    const { failure } = result;
    if (failure.code === 'email-verification-required') {
      rememberEmail(email.trim());
      router.push('/check-email?from=sign-in');
      return;
    }
    if (failure.code === 'validation.failed') {
      setFieldErrors(fieldErrorKeys(failure, ['email', 'password']));
      return;
    }
    setPassword('');
    if (failure.code === 'request.throttled') {
      setThrottled(true);
      throttle.start(failure.details?.retryAfterSeconds ?? 60);
    }
    setFormError(formErrorKey(failure));
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-5">
      {notice ? <Banner tone="info">{t(`sign-in.banner.${notice}`)}</Banner> : null}
      {formError ? (
        <Banner tone="critical">
          {t(`error.${formError.key}`, formError.values)}
          {throttled ? ` ${t('sign-in.help.throttled')}` : ''}
        </Banner>
      ) : null}
      <TextField
        label={t('common.label.email')}
        type="email"
        name="email"
        autoComplete="username"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={fieldErrors['email'] ? t(`error.${fieldErrors['email']}`) : undefined}
      />
      <TextField
        label={t('common.label.password')}
        type="password"
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        showLabel={t('common.action.show-password')}
        hideLabel={t('common.action.hide-password')}
        error={fieldErrors['password'] ? t(`error.${fieldErrors['password']}`) : undefined}
      />
      <div className="flex items-start gap-2">
        <input
          id="keep-signed-in"
          type="checkbox"
          checked={keepSignedIn}
          onChange={(event) => setKeepSignedIn(event.target.checked)}
          aria-describedby="keep-signed-in-help"
          className="mt-1 size-4"
        />
        <div>
          <label htmlFor="keep-signed-in" className="text-sm font-medium text-fg">
            {t('sign-in.label.keep-signed-in')}
          </label>
          <p id="keep-signed-in-help" className="text-sm text-fg-muted">
            {t('sign-in.help.keep-signed-in')}
          </p>
        </div>
      </div>
      <Button type="submit" block loading={pending} disabled={throttle.blocked}>
        {t('sign-in.action.submit')}
      </Button>
      <div className="flex flex-col gap-2 text-sm">
        <Link href="/forgot-password" className="text-link hover:underline">
          {t('sign-in.action.forgot')}
        </Link>
        <Link href="/sign-up" className="text-link hover:underline">
          {t('sign-in.action.sign-up')}
        </Link>
      </div>
      <p className="text-sm text-fg-muted">{t('sign-in.note.separate')}</p>
    </form>
  );
}
