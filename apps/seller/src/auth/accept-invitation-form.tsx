'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { FocusHeading } from './focus-heading.tsx';
import { useLinkToken } from './link-token.ts';
import { formErrorKey, passwordRuleKey } from './messages-for-errors.ts';
import { useFocusFirstInvalid } from './use-focus-first-invalid.ts';

/**
 * Accepting a seller invitation (a team member's, or the Seller Owner's): the token from the link
 * fragment, your name (the API ignores it for an owner invitation) and a new password. No session
 * opens; success points to sign-in. The token lives in memory only.
 */
export function AcceptInvitationForm({
  passwordMin,
  passwordMax,
}: {
  readonly passwordMin: number;
  readonly passwordMax: number;
}) {
  const t = useTranslations('identity');
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const link = useLinkToken();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{
    key: string;
    values?: Record<string, string | number>;
  } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const invalid = useMemo<Record<string, string>>(() => {
    const errors: Record<string, string> = {};
    if (nameError) errors['name'] = nameError;
    if (passwordError) errors['password'] = passwordError;
    return errors;
  }, [nameError, passwordError]);
  useFocusFirstInvalid(formRef, invalid);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (link.state !== 'present' || inFlight.current) return;
    const trimmed = name.trim();
    setError(null);
    setNameError(trimmed === '' ? 'validation.name.required' : null);
    setPasswordError(password === '' ? 'validation.password.required' : null);
    if (trimmed === '' || password === '') return;
    inFlight.current = true;
    setPending(true);
    const result = await callApi('POST', 'identity/seller/accept-invitation', {
      token: link.token,
      displayName: trimmed,
      password,
    });
    inFlight.current = false;
    setPending(false);
    if (result.ok) {
      setPassword('');
      setDone(true);
      return;
    }
    const { failure } = result;
    if (failure.code === 'invitation.rejected') {
      setRejected(true);
      return;
    }
    if (failure.code === 'password.rejected') {
      setPasswordError(passwordRuleKey(failure));
      return;
    }
    if (failure.code === 'validation.failed') {
      const paths = (failure.details?.fields ?? []).map((field) => field.path);
      if (paths.includes('displayName')) setNameError('validation.name.characters');
      else if (paths.includes('password')) setPasswordError('validation.password.required');
      else setError({ key: 'unknown' });
      return;
    }
    if (failure.code === 'request.busy' || failure.code === 'access.unavailable') {
      setError({ key: 'accept.busy' });
      return;
    }
    setError(formErrorKey(failure));
  }

  if (link.state === 'checking') {
    return (
      <p role="status" className="text-fg-muted">
        {t('accept.status.checking')}
      </p>
    );
  }
  if (done) {
    return (
      <div className="flex flex-col gap-5">
        <FocusHeading>{t('accept.done.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('accept.done.body')}</p>
        <Link
          href="/sign-in"
          className="inline-flex min-h-12 items-center justify-center rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover"
        >
          {t('accept.done.action')}
        </Link>
      </div>
    );
  }
  if (link.state === 'missing' || rejected) {
    return (
      <div className="flex flex-col gap-5">
        <FocusHeading>{t('accept.rejected.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('accept.rejected.body')}</p>
        <Link
          href="/sign-in"
          className="inline-flex min-h-12 items-center text-sm text-link hover:underline"
        >
          {t('common.action.back-to-sign-in')}
        </Link>
      </div>
    );
  }
  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      <p className="text-fg-secondary">{t('accept.body')}</p>
      {error ? (
        <div data-form-problem tabIndex={-1}>
          <Banner tone="critical">{t(`error.${error.key}`, error.values)}</Banner>
        </div>
      ) : null}
      <TextField
        label={t('accept.label.name')}
        name="name"
        autoComplete="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={nameError ? t(`error.${nameError}`) : undefined}
      />
      <TextField
        label={t('common.label.new-password')}
        type="password"
        name="new-password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        showLabel={t('common.action.show-password')}
        hideLabel={t('common.action.hide-password')}
        help={t('common.help.password', { min: passwordMin, max: passwordMax })}
        error={
          passwordError
            ? t(`error.${passwordError}`, { min: passwordMin, max: passwordMax })
            : undefined
        }
      />
      <Button type="submit" block loading={pending}>
        {t('accept.action.submit')}
      </Button>
    </form>
  );
}
