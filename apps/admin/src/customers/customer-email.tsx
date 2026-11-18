'use client';

import { Banner, Button, ConfirmAction, Dialog, TextField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiFailure } from '../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { timeOf } from './format.ts';

/** The sign-in email an admin asked for and the customer has not confirmed yet. */
export interface PendingEmailChange {
  readonly email: string;
  readonly requestedAt: string;
}

const EMAIL_MAX = 254;
const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Edit email (customers management phase 2b, key `customers.customer-email.change`): the new
 * address, then a two-step code (the panel's guarded call asks for it when the API says so).
 * The API mails a link to the new address and a notice to the current one; the current address
 * keeps working until the customer confirms. The API takes no reason. A refusal keeps the dialog
 * open with the reason next to the field or in a line under it; sending again replaces the
 * pending request, which the dialog says.
 */
export function CustomerEmailDialog({
  open,
  accountId,
  email,
  pending,
  csrfToken,
  onClose,
  onSent,
}: {
  readonly open: boolean;
  readonly accountId: string;
  readonly email: string;
  readonly pending: PendingEmailChange | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSent: (change: PendingEmailChange) => void;
}) {
  const t = useTranslations('customers.email');
  const guarded = useGuardedCall();
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!open) return;
    setValue('');
    setFieldError(null);
    setError(null);
  }, [open]);

  function refusal(failure: ApiFailure) {
    switch (failure.code) {
      case 'validation.failed':
        setFieldError(t('error.invalid'));
        return;
      case 'customers.email-taken':
        setFieldError(t('error.taken'));
        return;
      case 'customers.customer-not-eligible':
        setError(t('error.not-eligible'));
        return;
      case 'customers.account-deletion-pending':
        setError(t('error.deletion-pending'));
        return;
      case 'customers.customer-not-found':
        setError(t('error.not-found'));
        return;
      case 'request.throttled': {
        const seconds = failure.details?.retryAfterSeconds;
        const minutes = Math.max(1, Math.ceil((seconds ?? 60) / 60));
        setError(t('error.throttled', { minutes }));
        return;
      }
      default:
        setError(t(failure.status === 403 ? 'error.denied' : 'error.unavailable'));
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current) return;
    const clean = value.trim();
    if (clean === '') {
      setFieldError(t('error.required'));
      return;
    }
    if (clean.length > EMAIL_MAX || !SHAPE.test(clean)) {
      setFieldError(t('error.invalid'));
      return;
    }
    if (clean.toLowerCase() === email.toLowerCase()) {
      setFieldError(t('error.same'));
      return;
    }
    busy.current = true;
    setSending(true);
    setFieldError(null);
    setError(null);
    const result = await guarded<{ changed: boolean; requestedAt: string | null }>(
      'PUT',
      `customers/admin/customers/${encodeURIComponent(accountId)}/email`,
      { email: clean },
      csrfToken,
    );
    busy.current = false;
    setSending(false);
    if (result.ok) {
      if (!result.body.changed) {
        // The API treats the current address as no change and spends nothing.
        setFieldError(t('error.same'));
        return;
      }
      toast.success(t('sent', { email: clean }));
      onSent({ email: clean, requestedAt: result.body.requestedAt ?? new Date().toISOString() });
      onClose();
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    refusal(result.failure);
  }

  const close = () => {
    if (!sending) onClose();
  };

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" disabled={sending} onClick={close}>
            {t('cancel')}
          </Button>
          <Button loading={sending} onClick={() => void send()}>
            {t('send')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void send(event)} noValidate>
        <TextField label={t('current')} value={email} readOnly />
        {pending === null ? null : (
          <TextField label={t('pending')} help={t('replaces')} value={pending.email} readOnly />
        )}
        <TextField
          label={t('new')}
          type="email"
          value={value}
          maxLength={EMAIL_MAX}
          autoComplete="off"
          spellCheck={false}
          error={fieldError ?? undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setFieldError(null);
          }}
        />
        <p className="text-sm text-fg-muted">{t('note')}</p>
        <p className="text-sm text-fg-muted">{t('step-up')}</p>
        {error === null ? null : (
          <p role="alert" className="text-sm text-critical-fg">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The info banner under the header while a change waits for the customer's confirmation. */
export function PendingEmailBanner({
  pending,
  zone,
  canCancel,
  onCancel,
}: {
  readonly pending: PendingEmailChange;
  readonly zone: string;
  readonly canCancel: boolean;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('customers.email.banner');
  const locale = useLocale();
  return (
    <Banner tone="info">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="wrap-anywhere">
          {t('text', {
            email: pending.email,
            date: timeOf(pending.requestedAt, locale, zone),
          })}
        </span>
        {canCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
        ) : null}
      </div>
    </Banner>
  );
}

/** "Cancel the email change?" (level 2): the pending address is cleared and its link stops working. */
export function CancelEmailChangeDialog({
  open,
  accountId,
  pending,
  csrfToken,
  onClose,
  onCancelled,
}: {
  readonly open: boolean;
  readonly accountId: string;
  readonly pending: PendingEmailChange | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onCancelled: () => void;
}) {
  const t = useTranslations('customers.email.cancel-change');
  const tEmail = useTranslations('customers.email');
  const guarded = useGuardedCall();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    const result = await guarded<unknown>(
      'DELETE',
      `customers/admin/customers/${encodeURIComponent(accountId)}/email-change`,
      undefined,
      csrfToken,
    );
    busy.current = false;
    setWorking(false);
    if (result.ok) {
      toast.success(t('done'));
      onCancelled();
      onClose();
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.code === 'customers.email-change-not-found') {
      // The customer confirmed, or another admin cancelled: nothing is pending any more.
      toast.info(t('gone'));
      onCancelled();
      onClose();
      return;
    }
    if (result.failure.code === 'request.throttled') {
      const seconds = result.failure.details?.retryAfterSeconds;
      setError(t('throttled', { minutes: Math.max(1, Math.ceil((seconds ?? 60) / 60)) }));
      return;
    }
    setError(t(result.failure.status === 403 ? 'denied' : 'failed'));
  }

  return (
    <ConfirmAction
      open={open && pending !== null}
      level={2}
      title={t('title')}
      body={<p className="wrap-anywhere">{t('body', { email: pending?.email ?? '' })}</p>}
      rowName={pending?.email ?? ''}
      stepUpNote={tEmail('step-up')}
      confirmLabel={t('confirm')}
      cancelLabel={t('keep')}
      pending={working}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}
