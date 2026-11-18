'use client';

import { Button, ConfirmAction, Dialog, TextAreaField, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, type CustomerGroup } from './groups-types.ts';

/** The message key (under `customers.groups.error`) of a refused group change. */
export function groupProblemOf(failure: ApiFailure): string {
  switch (failure.code) {
    case 'customers.group-name-taken':
      return 'name-taken';
    case 'customers.group-limit-reached':
      return 'limit';
    case 'customers.group-not-found':
      return 'not-found';
    case 'customers.conflict':
      return 'conflict';
    case 'validation.failed':
      return 'invalid';
    case 'request.csrf':
      return 'csrf';
    case 'access.denied':
      return 'denied';
    default:
      return failure.status === 403 ? 'denied' : 'unavailable';
  }
}

/**
 * New group… and Rename… (customers management phase 2a): a name (1 to 80 characters, one per
 * Market whatever its case) and an optional description (at most 500). The help line says a
 * group is a label for admins, so no personal data goes in it. A rename sends the version read;
 * a stale one says another admin changed the group first.
 */
export function GroupDialog({
  open,
  group,
  csrfToken,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  /** The group to rename; null makes a new one. */
  readonly group: CustomerGroup | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (group: CustomerGroup) => void;
}) {
  const t = useTranslations('customers.groups');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setDescription(group?.description ?? '');
    setNameError(null);
    setError(null);
  }, [open, group]);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current) return;
    const cleanName = name.trim();
    if (cleanName === '') {
      setNameError(t('error.name-required'));
      return;
    }
    if (cleanName.length > GROUP_NAME_MAX) {
      setNameError(t('error.name-long', { max: GROUP_NAME_MAX }));
      return;
    }
    const cleanDescription = description.trim();
    busy.current = true;
    setPending(true);
    setNameError(null);
    setError(null);
    const result =
      group === null
        ? await callApi<CustomerGroup>(
            'POST',
            'customers/admin/groups',
            {
              name: cleanName,
              ...(cleanDescription === '' ? {} : { description: cleanDescription }),
            },
            csrfToken,
          )
        : await callApi<CustomerGroup>(
            'PUT',
            `customers/admin/groups/${encodeURIComponent(group.groupId)}`,
            {
              expectedVersion: group.version,
              name: cleanName,
              description: cleanDescription === '' ? null : cleanDescription,
            },
            csrfToken,
          );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(group === null ? 'created' : 'renamed', { name: result.body.name }));
      onSaved(result.body);
      onClose();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const problem = groupProblemOf(result.failure);
    if (problem === 'name-taken') setNameError(t('error.name-taken'));
    else setError(t(`error.${problem}`, { max: result.failure.details?.max ?? 0 }));
  }

  const close = () => {
    if (!pending) onClose();
  };

  return (
    <Dialog
      open={open}
      title={group === null ? t('new-title') : t('rename-title')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" disabled={pending} onClick={close}>
            {t('cancel')}
          </Button>
          <Button loading={pending} onClick={() => void save()}>
            {group === null ? t('create') : t('save')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)} noValidate>
        <TextField
          label={t('name')}
          value={name}
          maxLength={GROUP_NAME_MAX}
          required
          error={nameError ?? undefined}
          onChange={(event) => setName(event.target.value)}
        />
        <TextAreaField
          label={t('description')}
          help={t('description-help')}
          optionalLabel={t('optional')}
          value={description}
          maxLength={GROUP_DESCRIPTION_MAX}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
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

/**
 * Archive… and Restore… of a group (level 2). Archiving keeps the members but takes no new ones,
 * and no promotion reaches the group any more, which the dialog says before it happens.
 */
export function GroupArchiveDialog({
  group,
  csrfToken,
  onClose,
  onSaved,
}: {
  /** Null closes the dialog. */
  readonly group: CustomerGroup | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (group: CustomerGroup) => void;
}) {
  const t = useTranslations('customers.groups');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const archiving = group !== null && !group.archived;

  useEffect(() => {
    if (group === null) setError(null);
  }, [group]);

  async function confirm() {
    if (group === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await callApi<CustomerGroup>(
      'PUT',
      `customers/admin/groups/${encodeURIComponent(group.groupId)}`,
      { expectedVersion: group.version, archived: archiving },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(archiving ? 'archived' : 'restored', { name: result.body.name }));
      onSaved(result.body);
      onClose();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(t(`error.${groupProblemOf(result.failure)}`, { max: 0 }));
  }

  return (
    <ConfirmAction
      open={group !== null}
      level={2}
      title={t(archiving ? 'archive-title' : 'restore-title', { name: group?.name ?? '' })}
      body={
        <p className="wrap-anywhere">
          {archiving ? t('archive-body', { count: group?.memberCount ?? 0 }) : t('restore-body')}
        </p>
      }
      rowName={group?.name ?? ''}
      confirmLabel={t(archiving ? 'archive-confirm' : 'restore-confirm')}
      cancelLabel={t('cancel')}
      pending={pending}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={() => {
        if (!pending) onClose();
      }}
    />
  );
}
