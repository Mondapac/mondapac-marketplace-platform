'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { fieldErrorKeys, formErrorKey, passwordRuleKey } from './messages-for-errors.ts';
import { rememberEmail } from './pending-email.ts';

export function SignUpForm({
  passwordMin,
  passwordMax,
}: {
  readonly passwordMin: number;
  readonly passwordMax: number;
}) {
  const t = useTranslations('identity');
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    const result = await callApi('POST', 'identity/seller/sign-up', {
      displayName: name.trim(),
      email: email.trim(),
      password,
    });
    if (result.ok) {
      rememberEmail(email.trim());
      router.push('/check-email');
      return;
    }
    setPending(false);
    const { failure } = result;
    if (failure.code === 'validation.failed') {
      setFieldErrors(fieldErrorKeys(failure, ['name', 'email', 'password']));
      return;
    }
    if (failure.code === 'password.rejected') {
      setFieldErrors({ password: passwordRuleKey(failure) });
      return;
    }
    setFormError(formErrorKey(failure));
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-5">
      <p className="text-sm text-fg-secondary">{t('sign-up.body')}</p>
      {formError ? (
        <Banner tone="critical">{t(`error.${formError.key}`, formError.values)}</Banner>
      ) : null}
      <TextField
        label={t('common.label.name')}
        name="name"
        autoComplete="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={fieldErrors['name'] ? t(`error.${fieldErrors['name']}`) : undefined}
      />
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
        name="new-password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        showLabel={t('common.action.show-password')}
        hideLabel={t('common.action.hide-password')}
        help={t('common.help.password', { min: passwordMin, max: passwordMax })}
        error={
          fieldErrors['password']
            ? t(`error.${fieldErrors['password']}`, { min: passwordMin, max: passwordMax })
            : undefined
        }
      />
      <Button type="submit" block loading={pending}>
        {t('sign-up.action.submit')}
      </Button>
      <Link href="/sign-in" className="text-sm text-link hover:underline">
        {t('sign-up.action.sign-in')}
      </Link>
    </form>
  );
}
