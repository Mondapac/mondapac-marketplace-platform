'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { useLinkToken } from './link-token.ts';
import { formErrorKey } from './messages-for-errors.ts';

type Failure = { key: string; values?: Record<string, string | number> } | null;

export function ConfirmEmailForm() {
  const t = useTranslations('identity');
  const router = useRouter();
  const link = useLinkToken();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure>(null);
  const [rejected, setRejected] = useState(false);

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (link.state !== 'present') return;
    setPending(true);
    setError(null);
    const result = await callApi('POST', 'identity/seller/confirm-email', {
      token: link.token,
      password,
    });
    if (result.ok) {
      router.replace('/');
      router.refresh();
      return;
    }
    setPending(false);
    setPassword('');
    if (result.failure.code === 'link.rejected') {
      setRejected(true);
      return;
    }
    setError(formErrorKey(result.failure));
  }

  if (link.state === 'checking') {
    return (
      <p role="status" className="text-fg-muted">
        {t('confirm-email.status.checking')}
      </p>
    );
  }
  if (link.state === 'missing' || rejected) return <LinkRejected />;
  return (
    <form onSubmit={(event) => void confirm(event)} noValidate className="flex flex-col gap-5">
      <p className="text-fg-secondary">{t('confirm-email.body')}</p>
      {error ? <Banner tone="critical">{t(`error.${error.key}`, error.values)}</Banner> : null}
      <TextField
        label={t('common.label.password')}
        type="password"
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        showLabel={t('common.action.show-password')}
        hideLabel={t('common.action.hide-password')}
      />
      <Button type="submit" block loading={pending}>
        {t('confirm-email.action.submit')}
      </Button>
    </form>
  );
}

/** The "link not usable" state of A4: one answer for every cause, and a new link by email. */
function LinkRejected() {
  const t = useTranslations('identity');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure>(null);

  async function sendNew(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await callApi('POST', 'identity/seller/verification-email', {
      email: email.trim(),
    });
    setPending(false);
    if (result.ok) setSent(true);
    else setError(formErrorKey(result.failure));
  }

  return (
    <form onSubmit={(event) => void sendNew(event)} noValidate className="flex flex-col gap-5">
      <h2 className="text-lg font-semibold text-fg">{t('link.title.rejected')}</h2>
      <p className="text-fg-secondary">{t('link.body.rejected')}</p>
      {sent ? <Banner tone="success">{t('link.status.sent')}</Banner> : null}
      {error ? <Banner tone="critical">{t(`error.${error.key}`, error.values)}</Banner> : null}
      <TextField
        label={t('common.label.email')}
        type="email"
        name="email"
        autoComplete="username"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <Button type="submit" block loading={pending}>
        {t('link.action.send-new')}
      </Button>
    </form>
  );
}
