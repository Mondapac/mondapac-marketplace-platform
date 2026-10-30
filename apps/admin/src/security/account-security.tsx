'use client';

import {
  Badge,
  Banner,
  Button,
  OtpField,
  SettingRow,
  SettingsPage,
  SettingsSection,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { SetupQr } from '../auth/setup-qr.tsx';
import { replacementProblemOf, type Problem } from '../profile/errors.ts';

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'verify' }
  | { readonly kind: 'secret'; readonly secret: string; readonly otpauthUri: string }
  | { readonly kind: 'done' };

interface Started {
  readonly secret: string;
  readonly otpauthUri: string;
}

/** The secret as groups of four, for typing into an authenticator app. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Account security for the signed-in admin (personal page, opened from the account menu): the
 * state of two-step verification, which admins cannot turn off, and moving the authenticator to a
 * new device. The replacement runs on the API's own-session routes: a code from the current app
 * (or a backup code) starts it, the first code of the new app completes it. The new secret lives
 * in memory only. When it completes the API ends every other session, mails a notice and keeps
 * this one with a new token, so the page is refreshed.
 */
export function AccountSecurity({
  active,
  csrfToken,
}: {
  readonly active: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('security');
  const p = useTranslations('profile');
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [boxes, setBoxes] = useState(0);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);

  function go(next: Step) {
    setStep(next);
    setCode('');
    setBackup(false);
    setBoxes((n) => n + 1);
    setProblem(null);
    setCopied(false);
  }

  /** Runs one call; returns the body on success and shows the failure on the form otherwise. */
  async function call<T>(path: string, value: string): Promise<T | null> {
    if (busy.current) return null;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<T>(
      'POST',
      `identity/admin/second-factor/${path}`,
      { code: value.replace(/[\s-]/g, '') },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) return result.body;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return null;
    }
    const refused = replacementProblemOf(result.failure);
    setProblem(refused);
    if (refused.field === 'code') {
      setCode('');
      setBoxes((n) => n + 1);
    }
    return null;
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (code.trim() === '') return setProblem({ key: 'code-required', field: 'code' });
    const body = await call<Started>('replacement', code);
    if (body) go({ kind: 'secret', secret: body.secret, otpauthUri: body.otpauthUri });
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (code.trim() === '') return setProblem({ key: 'code-required', field: 'code' });
    const body = await call<unknown>('replacement/confirm', code);
    if (body) {
      go({ kind: 'done' });
      router.refresh();
    }
  }

  async function copyKey(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const errorOf = (field: 'code') =>
    problem?.field === field ? p(`error.${problem.key}`, problem.values) : undefined;
  const wholeForm =
    problem === null || problem.field !== null ? null : (
      <Banner tone="critical">{p(`error.${problem.key}`, problem.values)}</Banner>
    );
  const codeField = (label: string) =>
    backup ? (
      <TextField
        key={`backup-${boxes}`}
        name="code"
        label={p('backup-label')}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        dir="ltr"
        value={code}
        error={errorOf('code')}
        onChange={(event) => setCode(event.target.value)}
      />
    ) : (
      <OtpField
        key={`app-${boxes}`}
        label={label}
        digitLabel={(position, total) => p('code-digit', { position, total })}
        name="code"
        autoFocus
        readOnly={pending}
        error={errorOf('code')}
        onChange={setCode}
      />
    );
  const toggleBackup = (
    <button
      type="button"
      disabled={pending}
      className="min-h-11 self-start text-sm font-medium text-link underline disabled:opacity-60"
      onClick={() => {
        setBackup((value) => !value);
        setCode('');
        setProblem(null);
      }}
    >
      {p(backup ? 'use-app' : 'use-backup')}
    </button>
  );

  let flow = null;
  if (step.kind === 'verify') {
    flow = (
      <form
        onSubmit={(event) => void verify(event)}
        noValidate
        aria-labelledby="replace-verify-title"
        className="flex flex-col gap-4 px-5 py-4 sm:max-w-md"
      >
        <h3 id="replace-verify-title" className="text-base font-semibold text-fg">
          {t('replace.verify-title')}
        </h3>
        <p className="text-sm text-fg-muted">{t('replace.verify-body')}</p>
        {wholeForm}
        {codeField(t('replace.current-code'))}
        {toggleBackup}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={pending}>
            {t('replace.continue')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => go({ kind: 'idle' })}>
            {t('replace.cancel')}
          </Button>
        </div>
      </form>
    );
  } else if (step.kind === 'secret') {
    const { secret, otpauthUri } = step;
    flow = (
      <form
        onSubmit={(event) => void confirm(event)}
        noValidate
        aria-labelledby="replace-secret-title"
        className="flex flex-col gap-4 px-5 py-4 sm:max-w-md"
      >
        <h3 id="replace-secret-title" className="text-base font-semibold text-fg">
          {t('replace.secret-title')}
        </h3>
        <p className="text-sm text-fg-muted">{t('replace.secret-body')}</p>
        {wholeForm}
        {otpauthUri.startsWith('otpauth://') ? (
          <SetupQr
            uri={otpauthUri}
            label={t('replace.qr-label')}
            intro={t('replace.scan')}
            fallback={t('replace.cannot-scan')}
          />
        ) : null}
        <span className="text-sm text-fg-muted">{t('replace.key-label')}</span>
        <code dir="ltr" className="font-mono text-base break-all">
          {grouped(secret)}
        </code>
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" variant="secondary" onClick={() => void copyKey(secret)}>
            {copied ? t('replace.copied') : t('replace.copy')}
          </Button>
        </div>
        <OtpField
          key={`new-${boxes}`}
          label={t('replace.new-code')}
          digitLabel={(position, total) => p('code-digit', { position, total })}
          name="code"
          readOnly={pending}
          error={errorOf('code')}
          onChange={setCode}
        />
        <Banner tone="info">{t('replace.effect')}</Banner>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={pending}>
            {t('replace.confirm')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => go({ kind: 'idle' })}>
            {t('replace.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <SettingsPage title={t('title')} description={t('description')}>
      {step.kind === 'done' ? <Banner tone="success">{t('replace.done')}</Banner> : null}
      <SettingsSection title={t('two-step.title')} description={t('two-step.description')}>
        <SettingRow label={t('two-step.status')} help={t('two-step.cannot-turn-off')} plain>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={active ? 'success' : 'attention'}>
              {t(active ? 'two-step.on' : 'two-step.off')}
            </Badge>
          </div>
        </SettingRow>
        {active ? (
          <SettingRow label={t('replace.label')} help={t('replace.help')} plain>
            {step.kind === 'idle' || step.kind === 'done' ? (
              <Button type="button" variant="secondary" onClick={() => go({ kind: 'verify' })}>
                {t('replace.action')}
              </Button>
            ) : (
              <p className="text-sm text-fg-muted">{t('replace.in-progress')}</p>
            )}
          </SettingRow>
        ) : (
          <SettingRow label={t('replace.label')} plain>
            <p className="text-sm text-fg-secondary">{t('two-step.off-guidance')}</p>
          </SettingRow>
        )}
        {flow}
      </SettingsSection>
      <SettingsSection title={t('lost.title')}>
        <SettingRow label={t('lost.label')} help={t('lost.help')} plain>
          <p className="text-sm text-fg-secondary">{t('lost.guidance')}</p>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title={t('sessions.title')}>
        <SettingRow label={t('sessions.label')} help={t('sessions.help')} plain>
          <a
            href="/account/sessions"
            className="inline-flex min-h-12 items-center text-sm font-medium text-link underline"
          >
            {t('sessions.link')}
          </a>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
