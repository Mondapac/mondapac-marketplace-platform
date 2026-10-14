'use client';

import { Banner, Button, Card, CheckboxRow, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { FocusHeading } from '../auth/focus-heading.tsx';
import { SetupQr } from '../auth/setup-qr.tsx';
import { formErrorKey, type ErrorKey } from '../auth/messages-for-errors.ts';

type View =
  | { readonly kind: 'idle' }
  | { readonly kind: 'password' }
  | {
      readonly kind: 'secret';
      readonly challengeToken: string;
      readonly secret: string;
      readonly otpauthUri: string;
    }
  | { readonly kind: 'codes'; readonly codes: readonly string[]; readonly enrolled: boolean }
  | { readonly kind: 'remove' }
  | { readonly kind: 'regenerate' }
  | { readonly kind: 'removed' };

interface Enrolment {
  readonly challengeToken: string;
  readonly secret: string;
  readonly otpauthUri: string;
}

/** The secret as groups of four, for typing into an authenticator app. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Two-step verification for the signed-in seller (optional at launch). Off: password, then the
 * key with the first code, then the backup codes shown once. On: turn off, or get new backup
 * codes, each asking for a code. The secret and the codes live in memory only.
 */
export function TwoStepPanel({
  active,
  csrfToken,
}: {
  readonly active: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('security');
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'key' | 'codes' | null>(null);
  const e = useTranslations('identity');

  function go(next: View) {
    setView(next);
    setValue('');
    setError(null);
    setSaved(false);
    setCopied(null);
  }

  /** Runs one call; returns the body on success, and shows the failure on the form otherwise. */
  async function call<T>(path: string, body: unknown): Promise<T | null> {
    setPending(true);
    setError(null);
    const result = await callApi<T>('POST', `identity/seller/${path}`, body, csrfToken);
    setPending(false);
    if (result.ok) return result.body;
    if (result.failure.status === 401) {
      router.replace('/session-ended');
      return null;
    }
    const { code } = result.failure;
    if (code === 'challenge.rejected' && view.kind === 'secret') {
      // The enrolment challenge expired or was replaced: start again from the password.
      go({ kind: 'password' });
      setError({ key: 'second-factor.enrolment-expired' });
      return null;
    }
    // Keep what was typed when the call did not reach a verdict.
    if (code !== 'network' && code !== 'request.throttled') setValue('');
    setError(
      code === 'validation.failed'
        ? { key: 'validation.code.required' }
        : formErrorKey(result.failure),
    );
    return null;
  }

  const clean = (text: string) => text.replace(/[\s-]/g, '');

  async function start(event: FormEvent) {
    event.preventDefault();
    const body = await call<Enrolment>('second-factor/enrolment', { password: value });
    if (body) go({ kind: 'secret', ...body });
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (view.kind !== 'secret') return;
    const body = await call<{ recoveryCodes: string[] }>('second-factor/enrolment/confirm', {
      challengeToken: view.challengeToken,
      code: clean(value),
    });
    if (body) go({ kind: 'codes', codes: body.recoveryCodes, enrolled: true });
  }

  async function remove(event: FormEvent) {
    event.preventDefault();
    const body = await call<unknown>('second-factor/remove', { code: clean(value) });
    if (body) {
      go({ kind: 'removed' });
      router.refresh();
    }
  }

  async function regenerate(event: FormEvent) {
    event.preventDefault();
    const body = await call<{ recoveryCodes: string[] }>('second-factor/recovery-codes', {
      code: clean(value),
    });
    if (body) go({ kind: 'codes', codes: body.recoveryCodes, enrolled: false });
  }

  async function copy(text: string, what: 'key' | 'codes') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  }

  function download(codes: readonly string[]) {
    const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mondapac-recovery-codes.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const problem = error ? (
    <Banner tone="critical">{e(`error.${error.key}`, error.values)}</Banner>
  ) : null;
  const form = (onSubmit: (event: FormEvent) => Promise<void>, children: ReactNode) => (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
      {problem}
      {children}
    </form>
  );
  const cancel = (
    <Button type="button" variant="secondary" block onClick={() => go({ kind: 'idle' })}>
      {t('action.cancel')}
    </Button>
  );

  let body: ReactNode;
  if (view.kind === 'password') {
    body = form(
      start,
      <>
        <FocusHeading key={view.kind}>{t('password.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('password.body')}</p>
        <TextField
          label={t('password.label')}
          type="password"
          name="password"
          autoComplete="current-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          showLabel={e('common.action.show-password')}
          hideLabel={e('common.action.hide-password')}
        />
        <Button type="submit" block loading={pending}>
          {t('action.verify')}
        </Button>
        {cancel}
      </>,
    );
  } else if (view.kind === 'secret') {
    body = form(
      confirm,
      <>
        <FocusHeading key={view.kind}>{t('secret.title')}</FocusHeading>
        <SetupQr
          uri={view.otpauthUri}
          label={t('secret.qr-label')}
          intro={t('secret.scan')}
          fallback={t('secret.cannot-scan')}
        />
        <span className="text-sm text-fg-muted">{t('secret.key-label')}</span>
        <code dir="ltr" className="font-mono text-base break-all">
          {grouped(view.secret)}
        </code>
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" variant="secondary" onClick={() => void copy(view.secret, 'key')}>
            {copied === 'key' ? t('action.copied') : t('action.copy')}
          </Button>
          {view.otpauthUri.startsWith('otpauth://') ? (
            <a
              href={view.otpauthUri}
              className="inline-flex min-h-12 items-center text-sm text-link hover:underline"
            >
              {t('secret.open-app')}
            </a>
          ) : null}
        </div>
        <TextField
          label={t('secret.code-label')}
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          dir="ltr"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" block loading={pending}>
          {t('action.confirm')}
        </Button>
        {cancel}
      </>,
    );
  } else if (view.kind === 'codes') {
    const { codes, enrolled } = view;
    body = (
      <div className="flex flex-col gap-4">
        <FocusHeading key={view.kind}>{t('codes.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('codes.body')}</p>
        <ul
          dir="ltr"
          className="grid grid-cols-1 gap-2 rounded-md border border-border p-4 font-mono sm:grid-cols-2"
        >
          {codes.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void copy(codes.join('\n'), 'codes')}
          >
            {copied === 'codes' ? t('action.copied') : t('action.copy')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => download(codes)}>
            {t('action.download')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => window.print()}>
            {t('action.print')}
          </Button>
        </div>
        <CheckboxRow
          label={t('codes.saved')}
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        <Banner tone="info">{t('codes.once')}</Banner>
        {enrolled ? <Banner tone="info">{t('codes.ended-sessions')}</Banner> : null}
        <Button
          type="button"
          block
          disabled={!saved}
          onClick={() => {
            if (enrolled) {
              router.replace('/sign-in?notice=two-step-enabled');
            } else {
              go({ kind: 'idle' });
            }
            router.refresh();
          }}
        >
          {t(enrolled ? 'action.sign-in-again' : 'action.done')}
        </Button>
      </div>
    );
  } else if (view.kind === 'remove' || view.kind === 'regenerate') {
    const which = view.kind;
    body = form(
      which === 'remove' ? remove : regenerate,
      <>
        <FocusHeading key={view.kind}>{t(`${which}.title`)}</FocusHeading>
        <p className="text-fg-secondary">{t(`${which}.body`)}</p>
        <TextField
          label={t(`${which}.label`)}
          name="code"
          autoComplete="one-time-code"
          dir="ltr"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" block loading={pending}>
          {t('action.confirm')}
        </Button>
        {cancel}
      </>,
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {view.kind === 'removed' ? <Banner tone="info">{t('remove.done')}</Banner> : null}
        <p role="status" className="font-medium">
          {t(active ? 'status.on' : 'status.off')}
        </p>
        <p className="text-fg-secondary">{t('intro')}</p>
        {active ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="secondary" onClick={() => go({ kind: 'regenerate' })}>
              {t('action.new-codes')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => go({ kind: 'remove' })}>
              {t('action.turn-off')}
            </Button>
          </div>
        ) : (
          <Button type="button" onClick={() => go({ kind: 'password' })}>
            {t('action.turn-on')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card>
      <div className="max-w-xl">{body}</div>
    </Card>
  );
}
