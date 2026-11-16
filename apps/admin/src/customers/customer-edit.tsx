'use client';

import { Button, Dialog, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { DISPLAY_NAME_MAX } from './groups-types.ts';

/**
 * Edit customer (customers management phase 2a, key `customers.customers.edit`): the display
 * name only (Reza, 16 Nov: status stays on Disable/Enable…, one path and one confirmation).
 * Identity saves it and records it; a disabled or unverified account keeps its name, which the
 * dialog says. A save is level 1: it changes a label, nothing the customer must act on.
 */
export function CustomerEditDialog({
  open,
  accountId,
  displayName,
  csrfToken,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly accountId: string;
  readonly displayName: string | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (displayName: string) => void;
}) {
  const t = useTranslations('customers.edit');
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName(displayName ?? '');
    setFieldError(null);
    setError(null);
  }, [open, displayName]);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current) return;
    const clean = name.trim();
    if (clean === '') {
      setFieldError(t('error.required'));
      return;
    }
    if (clean.length > DISPLAY_NAME_MAX) {
      setFieldError(t('error.long', { max: DISPLAY_NAME_MAX }));
      return;
    }
    if (clean === (displayName ?? '').trim()) {
      onClose();
      return;
    }
    busy.current = true;
    setPending(true);
    setFieldError(null);
    setError(null);
    const result = await callApi(
      'PUT',
      `customers/admin/customers/${encodeURIComponent(accountId)}/display-name`,
      { displayName: clean },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t('saved'));
      onSaved(clean);
      onClose();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    switch (result.failure.code) {
      case 'validation.failed':
        setFieldError(t('error.invalid'));
        return;
      case 'customers.customer-not-eligible':
        setError(t('error.not-eligible'));
        return;
      case 'customers.customer-not-found':
        setError(t('error.not-found'));
        return;
      case 'request.throttled':
        setError(t('error.throttled'));
        return;
      default:
        setError(t(result.failure.status === 403 ? 'error.denied' : 'error.unavailable'));
    }
  }

  const close = () => {
    if (!pending) onClose();
  };

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" disabled={pending} onClick={close}>
            {t('cancel')}
          </Button>
          <Button loading={pending} onClick={() => void save()}>
            {t('save')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)} noValidate>
        <TextField
          label={t('name')}
          help={t('name-help')}
          value={name}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="off"
          error={fieldError ?? undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {error === null ? null : (
          <p role="alert" className="text-sm text-critical-fg">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
