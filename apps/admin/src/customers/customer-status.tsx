'use client';

import { Button, ConfirmAction, Dialog, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { customerProblemOf } from './errors.ts';

export interface StatusTarget {
  readonly accountId: string;
  readonly email: string;
  readonly status: 'active' | 'disabled';
}

/**
 * Disable or enable one customer account (identity slice 8c), from a list row's Actions menu or
 * the customer page. Disable is a level-2 confirmation (it affects the customer: signed out on
 * every device), red, with focus on Cancel. Enable only gives access back, so its button is the
 * primary one. The server checks the key again; a refusal stays in the dialog.
 */
export function CustomerStatusDialog({
  target,
  csrfToken,
  onClose,
  onChanged,
}: {
  /** The account to change; null closes the dialog. */
  readonly target: StatusTarget | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onChanged: (status: 'active' | 'disabled') => void;
}) {
  const t = useTranslations('customers');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const disabling = target?.status === 'active';

  async function change() {
    if (target === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const action = disabling ? 'disable' : 'enable';
    const result = await callApi<{ code: string }>(
      'POST',
      `identity/admin/customers/${encodeURIComponent(target.accountId)}/${action}`,
      {},
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      const status = disabling ? 'disabled' : 'active';
      toast.success(t(disabling ? 'changed.disabled' : 'changed.enabled'));
      onChanged(status);
      onClose();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(t(`error.${customerProblemOf(result.failure)}`));
  }

  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };

  if (target !== null && !disabling) {
    return (
      <Dialog
        open
        title={t('enable.title')}
        onClose={close}
        actions={
          <>
            <Button variant="secondary" disabled={pending} onClick={close}>
              {t('cancel')}
            </Button>
            <Button loading={pending} onClick={() => void change()}>
              {t('enable.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="wrap-anywhere">{t('enable.body', { email: target.email })}</p>
          {error === null ? null : (
            <p role="alert" className="text-sm text-critical-fg">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <ConfirmAction
      open={target !== null}
      level={2}
      title={t('disable.title')}
      body={<p className="wrap-anywhere">{t('disable.body', { email: target?.email ?? '' })}</p>}
      rowName={target?.email ?? ''}
      confirmLabel={t('disable.confirm')}
      cancelLabel={t('cancel')}
      pending={pending}
      error={error}
      onConfirm={() => void change()}
      onCancel={close}
    />
  );
}
