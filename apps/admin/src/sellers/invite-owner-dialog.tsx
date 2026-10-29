'use client';

import { Banner, Button, Dialog, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { shortSellerId } from './orphaned-types.ts';

/** The longest owner name the API accepts (identity display-name rule). */
export const OWNER_NAME_MAX = 100;
const FORM_ID = 'invite-owner-form';
const DEFAULT_WAIT_SECONDS = 60;
/** A plain address check; the API is the authority. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/** Answers that mean the list is out of date: the list is reloaded and the dialog says why. */
const REFRESH_AFTER: ReadonlySet<string> = new Set([
  'seller.unknown',
  'invitation.already-pending',
  'seller.has-members',
  'conflict.stale',
]);

/** A throttled invitation: when sending may be tried again, and the wait to show. */
export interface InviteWait {
  readonly until: number;
  readonly minutes: number;
}

function useMessageFor() {
  const t = useTranslations('sellers.orphaned.invite.error');
  return (code: string): string => (t.has(code) ? t(code) : t('unknown'));
}

/** One submit at a time, even when the button is pressed twice before a render. */
function useSingleFlight() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  return {
    pending,
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setPending(true);
      try {
        return await task();
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
  };
}

/** Invite the owner of a seller that has none (POST identity/admin/sellers/:id/invitations). */
export function InviteOwnerDialog({
  open,
  sellerId,
  csrfToken,
  wait,
  onThrottled,
  onClose,
  onInvited,
  onStale,
}: {
  readonly open: boolean;
  readonly sellerId: string | null;
  readonly csrfToken: string;
  readonly wait: InviteWait | null;
  readonly onThrottled: (wait: InviteWait) => void;
  readonly onClose: () => void;
  readonly onInvited: (sellerId: string) => void;
  readonly onStale: () => void;
}) {
  const t = useTranslations('sellers.orphaned.invite');
  const messageFor = useMessageFor();
  const flight = useSingleFlight();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // A closed dialog starts clean next time.
  useEffect(() => {
    if (!open) {
      setEmail('');
      setName('');
      setEmailError(null);
      setNameError(null);
      setProblem(null);
    }
  }, [open]);

  // The submit button comes back when the wait ends.
  useEffect(() => {
    if (wait === null) return;
    const left = wait.until - Date.now();
    if (left <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), left);
    return () => clearTimeout(timer);
  }, [wait]);
  const waiting = wait !== null && now < wait.until;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (sellerId === null || waiting) return;
    const address = email.trim();
    const ownerName = name.trim();
    setEmailError(null);
    setNameError(null);
    setProblem(null);
    if (address === '') {
      setEmailError(t('validation.email.required'));
      return;
    }
    if (!EMAIL_SHAPE.test(address)) {
      setEmailError(t('validation.email.format'));
      return;
    }
    // The API needs the owner's name (1 to 100 characters): it is kept at acceptance.
    if (ownerName === '') {
      setNameError(t('validation.name.required'));
      return;
    }
    await flight.run(async () => {
      const result = await callApi(
        'POST',
        `identity/admin/sellers/${sellerId}/invitations`,
        { email: address, displayName: ownerName },
        csrfToken,
      );
      if (result.ok) {
        onClose();
        onInvited(sellerId);
        toast.success(t('toast-sent', { email: address }));
        return;
      }
      const failure = result.failure;
      if (failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      if (failure.code === 'request.throttled') {
        const seconds = failure.details?.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS;
        const next = {
          until: Date.now() + seconds * 1000,
          minutes: Math.max(1, Math.ceil(seconds / 60)),
        };
        setNow(Date.now());
        onThrottled(next);
        return;
      }
      if (failure.code === 'validation.failed') {
        const fields = failure.details?.fields ?? [];
        if (fields.some((field) => field.path === 'email'))
          setEmailError(t('validation.email.format'));
        else if (fields.some((field) => field.path === 'displayName'))
          setNameError(t('validation.name.invalid'));
        else setProblem(messageFor('unknown'));
        return;
      }
      if (REFRESH_AFTER.has(failure.code)) onStale();
      setProblem(messageFor(failure.status === 403 ? 'access.denied' : failure.code));
    });
  }

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={() => {
        if (!flight.pending) onClose();
      }}
      actions={
        <>
          <Button
            variant="secondary"
            className="min-h-12"
            onClick={onClose}
            disabled={flight.pending}
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            className="min-h-12"
            loading={flight.pending}
            disabled={waiting}
          >
            {t('submit')}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(event) => void submit(event)}
        noValidate
        className="flex flex-col gap-4"
      >
        {sellerId === null ? null : (
          <p className="text-sm text-fg-muted">{t('seller', { id: shortSellerId(sellerId) })}</p>
        )}
        <TextField
          label={t('label.email')}
          type="email"
          name="email"
          autoComplete="off"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={emailError ?? undefined}
        />
        <TextField
          label={t('label.name')}
          name="displayName"
          autoComplete="off"
          required
          maxLength={OWNER_NAME_MAX}
          help={t('help.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError ?? undefined}
        />
        <p className="text-sm text-fg-muted">{t('help.email')}</p>
        {waiting && wait !== null ? (
          <Banner tone="critical">{t('error.request.throttled', { minutes: wait.minutes })}</Banner>
        ) : null}
        {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      </form>
    </Dialog>
  );
}
