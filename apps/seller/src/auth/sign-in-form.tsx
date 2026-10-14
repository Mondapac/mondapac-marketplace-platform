'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FocusHeading } from './focus-heading.tsx';
import { useFocusFirstInvalid } from './use-focus-first-invalid.ts';
import { callApi, type ApiFailure } from '../api/client.ts';
import { fieldErrorKeys, formErrorKey, type ErrorKey } from './messages-for-errors.ts';
import { rememberEmail } from './pending-email.ts';
import { useThrottle } from './use-throttle.ts';

export type SignInNotice =
  'session-ended' | 'signed-out' | 'password-changed' | 'two-step-enabled' | null;

/** The password step, then (an account with two-step verification) the code step. */
export function SignInForm({ notice }: { readonly notice: SignInNotice }) {
  const [step, setStep] = useState<{ token: string; keepSignedIn: boolean } | null>(null);
  const [ended, setEnded] = useState<ApiFailure | null>(null);
  if (step !== null) {
    return (
      <CodeStep
        challengeToken={step.token}
        keepSignedIn={step.keepSignedIn}
        onBack={() => setStep(null)}
        onEnded={(failure) => {
          setEnded(failure);
          setStep(null);
        }}
      />
    );
  }
  return (
    <PasswordForm
      notice={notice}
      endedBy={ended}
      onCode={(token, keepSignedIn) => {
        setEnded(null);
        setStep({ token, keepSignedIn });
      }}
    />
  );
}

function PasswordForm({
  notice,
  endedBy,
  onCode,
}: {
  readonly notice: SignInNotice;
  /** Why the code step ended, when it did: the message and any wait show here. */
  readonly endedBy: ApiFailure | null;
  readonly onCode: (token: string, keepSignedIn: boolean) => void;
}) {
  const t = useTranslations('identity');
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const throttle = useThrottle();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<ErrorKey>(() =>
    endedBy === null ? null : formErrorKey(endedBy),
  );
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [throttled, setThrottled] = useState(false);

  useFocusFirstInvalid(formRef, fieldErrors);
  useEffect(() => {
    if (endedBy?.code === 'second-factor.locked') {
      throttle.start(endedBy.details?.retryAfterSeconds ?? 60);
    }
    // Runs once, when the form appears after the code step.
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    setThrottled(false);
    const result = await callApi<{
      code: 'signed-in' | 'second-factor-required';
      challengeToken?: string;
    }>('POST', 'identity/seller/sign-in', {
      email: email.trim(),
      password,
      keepSignedIn,
    });
    if (result.ok) {
      if (result.body.code === 'second-factor-required' && result.body.challengeToken) {
        setPending(false);
        setPassword('');
        onCode(result.body.challengeToken, keepSignedIn);
        return;
      }
      router.replace('/');
      router.refresh();
      return;
    }
    const { failure } = result;
    if (failure.code === 'email-verification-required') {
      // Stay pending: the page is about to change.
      rememberEmail(email.trim());
      router.push('/check-email?from=sign-in');
      return;
    }
    setPending(false);
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

function CodeStep({
  challengeToken,
  keepSignedIn,
  onBack,
  onEnded,
}: {
  readonly challengeToken: string;
  readonly keepSignedIn: boolean;
  readonly onBack: () => void;
  readonly onEnded: (failure: ApiFailure) => void;
}) {
  const t = useTranslations('identity');
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const throttle = useThrottle();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<ErrorKey>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  useFocusFirstInvalid(formRef, fieldErrors);

  useEffect(() => {
    const previous = document.title;
    document.title = t('two-step.page-title');
    return () => {
      document.title = previous;
    };
  }, [t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    const result = await callApi<{ code: 'signed-in' }>(
      'POST',
      'identity/seller/sign-in/second-factor',
      // A code pasted from the app may carry spaces; a backup code may carry spaces or hyphens.
      { challengeToken, code: code.replace(/[\s-]/g, ''), keepSignedIn },
    );
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
      // The challenge is over: back to the password step, which says why.
      onEnded(failure);
      return;
    }
    if (failure.code === 'request.throttled') {
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
      <Button type="submit" block loading={pending} disabled={throttle.blocked}>
        {t('two-step.action.verify')}
      </Button>
      <button
        type="button"
        className="inline-flex min-h-12 items-center self-start text-sm text-link hover:underline"
        onClick={() => {
          setBackup(!backup);
          setCode('');
          setFormError(null);
          setFieldErrors({});
        }}
      >
        {t(backup ? 'two-step.action.use-app' : 'two-step.action.use-backup')}
      </button>
      <button
        type="button"
        className="inline-flex min-h-12 items-center self-start text-sm text-link hover:underline"
        onClick={onBack}
      >
        {t('two-step.action.back')}
      </button>
      <p className="text-sm text-fg-muted">{t('two-step.help')}</p>
    </form>
  );
}
