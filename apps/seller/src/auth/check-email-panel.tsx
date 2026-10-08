'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formErrorKey } from './messages-for-errors.ts';
import { recallEmail, rememberEmail } from './pending-email.ts';

export function CheckEmailPanel({ fromSignIn }: { readonly fromSignIn: boolean }) {
  const t = useTranslations('identity');
  const [email, setEmail] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [resent, setResent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    key: string;
    values?: Record<string, string | number>;
  } | null>(null);

  useEffect(() => setEmail(recallEmail()), []);

  async function resend(event: FormEvent) {
    event.preventDefault();
    const address = (email ?? typed).trim();
    setPending(true);
    setError(null);
    setResent(false);
    const result = await callApi('POST', 'identity/seller/verification-email', { email: address });
    setPending(false);
    if (result.ok) {
      rememberEmail(address);
      setEmail(address);
      setResent(true);
      return;
    }
    setError(formErrorKey(result.failure));
  }

  const body = email
    ? t(fromSignIn ? 'check-email.body-from-sign-in' : 'check-email.body', { email })
    : t('check-email.body-no-address');

  return (
    <form onSubmit={(event) => void resend(event)} noValidate className="flex flex-col gap-5">
      <p className="text-fg-secondary">{body}</p>
      <p className="text-sm text-fg-muted">{t('check-email.help')}</p>
      {resent ? <Banner tone="success">{t('check-email.status.resent')}</Banner> : null}
      {error ? <Banner tone="critical">{t(`error.${error.key}`, error.values)}</Banner> : null}
      {email === null ? (
        <TextField
          label={t('common.label.email')}
          type="email"
          name="email"
          autoComplete="username"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      ) : null}
      <Button type="submit" variant="secondary" block loading={pending}>
        {t('check-email.action.resend')}
      </Button>
      <div className="flex flex-col gap-2 text-sm">
        {fromSignIn ? null : (
          <Link href="/sign-up" className="text-link hover:underline">
            {t('check-email.action.wrong-address')}
          </Link>
        )}
        <Link href="/sign-in" className="text-link hover:underline">
          {t('common.action.back-to-sign-in')}
        </Link>
      </div>
    </form>
  );
}
