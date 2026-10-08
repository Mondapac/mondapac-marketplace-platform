'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { fieldErrorKeys, formErrorKey } from './messages-for-errors.ts';

export function ForgotPasswordForm() {
  const t = useTranslations('identity');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<{
    key: string;
    values?: Record<string, string | number>;
  } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    const address = email.trim();
    const result = await callApi('POST', 'identity/seller/password-reset-email', {
      email: address,
    });
    setPending(false);
    if (result.ok) {
      setSentTo(address);
      return;
    }
    if (result.failure.code === 'validation.failed') {
      setFieldErrors(fieldErrorKeys(result.failure, ['email']));
      return;
    }
    setFormError(formErrorKey(result.failure));
  }

  if (sentTo !== null) {
    return (
      <div className="flex flex-col gap-5">
        <h2 className="text-lg font-semibold text-fg">{t('forgot-password.sent.title')}</h2>
        <p className="text-fg-secondary">{t('forgot-password.sent.body', { email: sentTo })}</p>
        <Link href="/sign-in" className="text-sm text-link hover:underline">
          {t('common.action.back-to-sign-in')}
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-5">
      {formError ? (
        <Banner tone="critical">{t(`error.${formError.key}`, formError.values)}</Banner>
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
      <Button type="submit" block loading={pending}>
        {t('forgot-password.action.submit')}
      </Button>
      <Link href="/sign-in" className="text-sm text-link hover:underline">
        {t('common.action.back-to-sign-in')}
      </Link>
    </form>
  );
}
