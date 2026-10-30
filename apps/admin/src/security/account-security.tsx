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
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { SetupQr } from '../auth/setup-qr.tsx';
import { replacementProblemOf, type Problem } from '../profile/errors.ts';

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'verify' }
  | { readonly kind: 'secret'; readonly secret: string; readonly otpauthUri: string }
  | { readonly kind: 'done' };

type FocusTarget = 'secret' | 'code' | 'button' | 'done';

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
  csrfToken: initialCsrf,
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
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  // The token the next call sends. A completed replacement hands out a new one; the page refresh
  // brings the same one later, and the prop then wins again.
  const [csrfToken, setCsrfToken] = useState(initialCsrf);
  const [focus, setFocus] = useState<{ target: FocusTarget; n: number } | null>(null);
  const busy = useRef(false);
  // The step the person is on now, so an answer to a step they left is ignored.
  const stepKind = useRef<Step['kind']>('idle');
  const formRef = useRef<HTMLDivElement>(null);
  const secretHeading = useRef<HTMLHeadingElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const doneBanner = useRef<HTMLDivElement>(null);

  useEffect(() => setCsrfToken(initialCsrf), [initialCsrf]);

  useEffect(() => {
    if (focus === null) return;
    if (focus.target === 'secret') secretHeading.current?.focus();
    else if (focus.target === 'button') replaceButton.current?.focus();
    else if (focus.target === 'done') doneBanner.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, [focus]);

  function go(next: Step, target: FocusTarget | null = null) {
    stepKind.current = next.kind;
    setStep(next);
    setCode('');
    setBackup(false);
    setBoxes((n) => n + 1);
    setProblem(null);
    setCopy('idle');
    if (target !== null) setFocus((last) => ({ target, n: (last?.n ?? 0) + 1 }));
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
      setFocus((last) => ({ target: 'code', n: (last?.n ?? 0) + 1 }));
    }
    return null;
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (code.trim() === '') return setProblem({ key: 'code-required', field: 'code' });
    const body = await call<Started>('replacement', code);
    if (body && stepKind.current === 'verify') {
      go({ kind: 'secret', secret: body.secret, otpauthUri: body.otpauthUri }, 'secret');
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (code.trim() === '') return setProblem({ key: 'code-required', field: 'code' });
    const body = await call<{ readonly csrfToken?: string }>('replacement/confirm', code);
    if (body && stepKind.current === 'secret') {
      if (typeof body.csrfToken === 'string') setCsrfToken(body.csrfToken);
      go({ kind: 'done' }, 'done');
      router.refresh();
    }
  }

  async function copyKey(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopy('copied');
    } catch {
      setCopy('failed');
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
  const cancel = (
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={() => go({ kind: 'idle' }, 'button')}
    >
      {t('replace.cancel')}
    </Button>
  );

  let flow = null;
  if (step.kind === 'verify') {
    flow = (
      <div ref={formRef}>
        <form
          onSubmit={(event) => void verify(event)}
          noValidate
          aria-labelledby="replace-verify-title"
          className="flex flex-col gap-4 px-5 py-4 sm:max-w-md"
        >
          <div className="flex flex-col gap-2">
            <h3 id="replace-verify-title" className="text-base font-semibold text-fg">
              {t('replace.verify-title')}
            </h3>
            <p className="text-sm text-fg-muted">{t('replace.verify-body')}</p>
          </div>
          {wholeForm}
          {codeField(t('replace.current-code'))}
          {toggleBackup}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={pending}>
              {t('replace.continue')}
            </Button>
            {cancel}
          </div>
        </form>
      </div>
    );
  } else if (step.kind === 'secret') {
    const { secret, otpauthUri } = step;
    flow = (
      <div ref={formRef}>
        <form
          onSubmit={(event) => void confirm(event)}
          noValidate
          aria-labelledby="replace-secret-title"
          className="flex flex-col gap-4 px-5 py-4 sm:max-w-md"
        >
          <div className="flex flex-col gap-2">
            <h3
              id="replace-secret-title"
              ref={secretHeading}
              tabIndex={-1}
              className="text-base font-semibold text-fg outline-none focus-visible:outline-2 focus-visible:outline-focus"
            >
              {t('replace.secret-title')}
            </h3>
            <p className="text-sm text-fg-muted">{t('replace.secret-body')}</p>
          </div>
          {wholeForm}
          {otpauthUri.startsWith('otpauth://') ? (
            <SetupQr
              uri={otpauthUri}
              label={t('replace.qr-label')}
              intro={t('replace.scan')}
              fallback={t('replace.cannot-scan')}
            />
          ) : null}
          <span id="replace-key-label" className="text-sm text-fg-muted">
            {t('replace.key-label')}
          </span>
          <code
            dir="ltr"
            aria-labelledby="replace-key-label"
            className="font-mono text-base break-all"
          >
            {grouped(secret)}
          </code>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="button" variant="secondary" onClick={() => void copyKey(secret)}>
              {copy === 'copied' ? t('replace.copied') : t('replace.copy')}
            </Button>
            <p
              role="status"
              aria-live="polite"
              className={copy === 'failed' ? 'text-sm text-critical-fg' : 'sr-only'}
            >
              {copy === 'copied'
                ? t('replace.copied')
                : copy === 'failed'
                  ? t('replace.copy-failed')
                  : ''}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-base font-semibold text-fg">{t('replace.confirm-title')}</h4>
            <p className="text-sm text-fg-muted">{t('replace.confirm-body')}</p>
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
            {cancel}
          </div>
        </form>
      </div>
    );
  }

  return (
    <SettingsPage title={t('title')} description={t('description')}>
      {step.kind === 'done' ? (
        <div ref={doneBanner} tabIndex={-1} className="outline-none">
          <Banner tone="success">{t('replace.done')}</Banner>
        </div>
      ) : null}
      <SettingsSection title={t('two-step.title')} description={t('two-step.description')}>
        <SettingRow
          label={t('two-step.status')}
          help={active ? t('two-step.cannot-turn-off') : undefined}
          plain
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={active ? 'success' : 'attention'}>
              {t(active ? 'two-step.on' : 'two-step.off')}
            </Badge>
          </div>
        </SettingRow>
        {active ? (
          <SettingRow label={t('replace.label')} help={t('replace.help')} plain>
            {step.kind === 'idle' || step.kind === 'done' ? (
              <Button
                ref={replaceButton}
                type="button"
                variant="secondary"
                onClick={() => go({ kind: 'verify' })}
              >
                {t('replace.action')}
              </Button>
            ) : (
              <p className="text-sm text-fg-muted">{t('replace.in-progress')}</p>
            )}
          </SettingRow>
        ) : (
          <div className="px-5 py-4">
            <Banner tone="attention">{t('two-step.off-guidance')}</Banner>
          </div>
        )}
        {flow}
      </SettingsSection>
      {active ? (
        <SettingsSection title={t('lost.title')}>
          <SettingRow label={t('lost.label')} help={t('lost.help')} plain>
            <p className="text-sm text-fg-secondary">{t('lost.guidance')}</p>
          </SettingRow>
        </SettingsSection>
      ) : null}
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
