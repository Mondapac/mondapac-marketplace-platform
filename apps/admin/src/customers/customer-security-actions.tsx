'use client';

import { ConfirmAction, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { problemText } from './security-shared.tsx';

export type SecurityAction = 'password-reset' | 'sign-out';

/** A recently requested reset is refused for five minutes; the wait shown when no header says. */
const RESET_WAIT_SECONDS = 300;

/**
 * The two account actions of the customer page's header menu and Active sessions (customers
 * management phase 2b): "Send password reset…" and "Sign out everywhere…". Both are level-2
 * confirmations that say the consequence first; a refusal (a 429 says how many minutes to wait)
 * stays in the dialog. The server checks the key again and records both.
 */
export function CustomerSecurityActionDialog({
  action,
  accountId,
  csrfToken,
  onClose,
  onSignedOut,
}: {
  /** The action to confirm; null closes the dialog. */
  readonly action: SecurityAction | null;
  readonly accountId: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** Every session ended: the sessions list reads again. */
  readonly onSignedOut: () => void;
}) {
  const t = useTranslations('customers.security');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const id = encodeURIComponent(accountId);
  // The dialog keeps its words while it closes.
  const [shown, setShown] = useState<SecurityAction>('password-reset');
  const current = action ?? shown;
  if (action !== null && action !== shown) {
    setShown(action);
    setError(null);
  }

  async function confirm() {
    if (action === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    if (action === 'password-reset') {
      const result = await callApi<{ sent: true }>(
        'POST',
        `customers/admin/customers/${id}/password-reset`,
        {},
        csrfToken,
      );
      busy.current = false;
      setPending(false);
      if (result.ok) {
        toast.success(t('password-reset.done'));
        onClose();
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setError(problemText(result.failure, t, RESET_WAIT_SECONDS));
      return;
    }
    const result = await callApi<{ revokedSessions: number }>(
      'POST',
      `customers/admin/customers/${id}/sessions/end`,
      {},
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t('sign-out.done', { count: result.body.revokedSessions }));
      onSignedOut();
      onClose();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(problemText(result.failure, t));
  }

  return (
    <ConfirmAction
      open={action !== null}
      level={2}
      title={t(`${current}.title`)}
      body={<p>{t(`${current}.body`)}</p>}
      rowName=""
      confirmLabel={t(`${current}.confirm`)}
      cancelLabel={t('cancel')}
      pending={pending}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={() => {
        if (pending) return;
        setError(null);
        onClose();
      }}
    />
  );
}
