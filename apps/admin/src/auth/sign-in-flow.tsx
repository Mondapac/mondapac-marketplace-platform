'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { FocusHeading } from './focus-heading.tsx';
import { fieldErrorKeys, formErrorKey, type ErrorKey } from './messages-for-errors.ts';
import { useFocusFirstInvalid } from './use-focus-first-invalid.ts';
import { useThrottle } from './use-throttle.ts';

export type SignInNotice = 'session-ended' | 'signed-out' | 'password-changed' | 'account-ready';

type PasswordStep = { code: string; challengeToken?: string };

/**
 * Admin sign-in (identity ux F2, F7): the password step, then the code step (A7), or the notice
 * that a link to set up two-step verification again was mailed (A3, F6 step 6). The challenge
 * token lives in this component's memory only: never in the URL or in browser storage.
 */
export function SignInFlow({ notice }: { readonly notice: SignInNotice | null }) {
  const [challenge, setChallenge] = useState<string | null>(null);
  const [reEnrol, setReEnrol] = useState(false);
  const t = useTranslations('identity');
  if (reEnrol) {
    return (
      <div className="flex flex-col gap-4">
        <FocusHeading>{t('check-email.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('check-email.body.re-enrol')}</p>
        <button
          type="button"
          className="self-start text-sm text-link hover:underline"
          onClick={() => setReEnrol(false)}
        >
          {t('common.action.back-to-sign-in')}
        </button>
      </div>
    );
  }
  if (challenge !== null) {
    return <CodeStep challengeToken={challenge} onEnded={() => setChallenge(null)} />;
  }
  return (
    <PasswordForm
      notice={notice}
      onCode={(token) => setChallenge(token)}
      onReEnrol={() => setReEnrol(true)}
    />
  );
}

function PasswordForm({
  notice,
  onCode,
  onReEnrol,
}: {
  readonly notice: SignInNotice | null;
  readonly onCode: (token: string) => void;
  readonly onReEnrol: () => void;
}) {
  const t = useTranslations('identity');
  const formRef = useRef<HTMLFormElement>(null);
  const throttle = useThrottle();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<ErrorKey>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [throttled, setThrottled] = useState(false);
  useFocusFirstInvalid(formRef, fieldErrors);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    setThrottled(false);
    const result = await callApi<PasswordStep>('POST', 'identity/admin/sign-in', {
      email: email.trim(),
      password,
    });
    setPending(false);
    if (result.ok) {
      setPassword('');
      if (result.body.code === 'second-factor-required' && result.body.challengeToken) {
        onCode(result.body.challengeToken);
      } else if (result.body.code === 'second-factor-enrolment-required') {
        onReEnrol();
      } else {
        setFormError({ key: 'unknown' });
      }
      return;
    }
    const { failure } = result;
    if (failure.code === 'validation.failed') {
      setFieldErrors(fieldErrorKeys(failure, ['email', 'password']));
      return;
    }
    setPassword('');
    if (failure.code === 'request.throttled' || failure.code === 'second-factor.locked') {
      setThrottled(true);
      throttle.start(failure.details?.retryAfterSeconds ?? 60);
    }
    setFormError(formErrorKey(failure));
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
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
      <Button type="submit" block loading={pending} disabled={throttle.blocked}>
        {t('sign-in.action.submit')}
      </Button>
    </form>
  );
}

function CodeStep({
  challengeToken,
  onEnded,
}: {
  readonly challengeToken: string;
  readonly onEnded: () => void;
}) {
  const t = useTranslations('identity');
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<ErrorKey>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  useFocusFirstInvalid(formRef, fieldErrors);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    const result = await callApi<{ code: 'signed-in' }>('POST', 'identity/admin/second-factor', {
      challengeToken,
      code: code.trim(),
    });
    if (result.ok) {
      router.replace('/');
      router.refresh();
      return;
    }
    setPending(false);
    const { failure } = result;
    if (failure.code === 'validation.failed') {
      setFieldErrors(fieldErrorKeys(failure, ['code']));
      return;
    }
    setCode('');
    if (failure.code === 'challenge.rejected' || failure.code === 'second-factor.locked') {
      // The challenge is over: back to the password step, which says why (ux F7 step 1).
      onEnded();
      return;
    }
    setFormError(formErrorKey(failure));
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      <FocusHeading key={backup ? 'backup' : 'app'}>
        {t(backup ? 'two-step.title-backup' : 'two-step.title')}
      </FocusHeading>
      <p className="text-fg-secondary">{t(backup ? 'two-step.body-backup' : 'two-step.body')}</p>
      {formError ? (
        <Banner tone="critical">{t(`error.${formError.key}`, formError.values)}</Banner>
      ) : null}
      <TextField
        key={backup ? 'backup' : 'app'}
        label={t(backup ? 'two-step.label.backup-code' : 'two-step.label.code')}
        name="code"
        autoComplete="one-time-code"
        inputMode={backup ? 'text' : 'numeric'}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        error={fieldErrors['code'] ? t(`error.${fieldErrors['code']}`) : undefined}
        dir="ltr"
      />
      <Button type="submit" block loading={pending}>
        {t('two-step.action.verify')}
      </Button>
      <button
        type="button"
        className="self-start text-sm text-link hover:underline"
        onClick={() => {
          setBackup(!backup);
          setCode('');
          setFormError(null);
          setFieldErrors({});
        }}
      >
        {t(backup ? 'two-step.action.use-app' : 'two-step.action.use-backup')}
      </button>
      <p className="text-sm text-fg-muted">{t('two-step.help.admin')}</p>
    </form>
  );
}
