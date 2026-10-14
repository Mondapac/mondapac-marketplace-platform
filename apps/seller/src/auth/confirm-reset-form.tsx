'use client';

import { Banner, Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { FocusHeading } from './focus-heading.tsx';
import { useLinkToken } from './link-token.ts';
import { formErrorKey, type ErrorKey } from './messages-for-errors.ts';
import { useThrottle } from './use-throttle.ts';

/**
 * The Seller Owner confirms a reset of two-step sign-in that MondaPac support started (identity
 * slice 12, A11). The one-time token comes from the link's fragment and stays in memory. Nothing
 * changes until the owner presses the button; then the factor and its recovery codes are removed
 * and every session ends, so the page sends the owner to sign in again.
 */
export function ConfirmResetForm() {
  const t = useTranslations('identity');
  const link = useLinkToken();
  const throttle = useThrottle();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey>(null);
  const [state, setState] = useState<'ready' | 'done' | 'rejected'>('ready');

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (link.state !== 'present' || pending || throttle.blocked) return;
    setPending(true);
    setError(null);
    const result = await callApi('POST', 'identity/seller/second-factor/reset/confirm', {
      token: link.token,
    });
    setPending(false);
    if (result.ok) {
      setState('done');
      return;
    }
    // One answer for every cause of an unusable link (unknown, used, expired, replaced).
    if (result.failure.code === 'link.rejected' || result.failure.code === 'validation.failed') {
      setState('rejected');
      return;
    }
    if (result.failure.code === 'request.throttled') {
      throttle.start(result.failure.details?.retryAfterSeconds ?? 60);
    }
    setError(formErrorKey(result.failure));
  }

  if (link.state === 'checking') {
    return (
      <p role="status" className="text-fg-muted">
        {t('confirm-reset.status.checking')}
      </p>
    );
  }
  if (link.state === 'missing' || state === 'rejected') {
    return (
      <div className="flex flex-col gap-5">
        <FocusHeading>{t('link.title.rejected')}</FocusHeading>
        <p className="text-fg-secondary">{t('confirm-reset.rejected')}</p>
        <SignInLink />
      </div>
    );
  }
  if (state === 'done') {
    return (
      <div className="flex flex-col gap-5">
        <FocusHeading>{t('confirm-reset.done.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('confirm-reset.done.body')}</p>
        <SignInLink />
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void confirm(event)} noValidate className="flex flex-col gap-5">
      <p className="text-fg-secondary">{t('confirm-reset.body')}</p>
      <Banner tone="attention">{t('confirm-reset.warning')}</Banner>
      {error ? <Banner tone="critical">{t(`error.${error.key}`, error.values)}</Banner> : null}
      <Button type="submit" block loading={pending} disabled={throttle.blocked}>
        {t('confirm-reset.action.submit')}
      </Button>
      <p className="text-sm text-fg-muted">{t('confirm-reset.not-you')}</p>
    </form>
  );
}

function SignInLink() {
  const t = useTranslations('identity');
  return (
    <a
      className="inline-flex min-h-12 items-center self-start font-medium text-link underline"
      href="/sign-in"
    >
      {t('common.action.back-to-sign-in')}
    </a>
  );
}
