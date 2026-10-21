'use client';

import { Banner, Button, Dialog, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { useNotice } from './notice.tsx';
import { grantableOptions, roleLabel } from './role-label.ts';
import type { SellerRole } from './types.ts';
import { useFailureMessage, useSingleFlight } from './use-team.ts';

/** Answers that mean the list is out of date: the dialog closes and the list is reloaded. */
const CHANGED_MEANWHILE: ReadonlySet<string> = new Set([
  'conflict.stale',
  'account.unknown',
  'role.unknown',
]);

/** Change a member's role. The change applies from their next request; they stay signed in. */
export function ChangeRoleDialog({
  open,
  onClose,
  accountId,
  name,
  currentRoleId,
  roles,
  csrfToken,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly accountId: string;
  readonly name: string;
  readonly currentRoleId: string | null;
  readonly roles: readonly SellerRole[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('identity.team');
  const root = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const messageFor = useFailureMessage();
  const flight = useSingleFlight();
  const callGuarded = useGuardedCall();
  const [roleId, setRoleId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const options = useMemo(() => grantableOptions(root, roles), [root, roles]);
  const current = roles.find((role) => role.roleId === currentRoleId) ?? null;

  // A closed dialog starts clean next time: no old choice or error.
  useEffect(() => {
    if (!open) {
      setRoleId('');
      setProblem(null);
      setRoleError(null);
    }
  }, [open]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setRoleError(null);
    if (roleId === '') {
      setRoleError(t('dialog.change-role.choose'));
      return;
    }
    await flight.run(async () => {
      setProblem(null);
      const result = await callGuarded(
        'POST',
        `identity/seller/team/accounts/${accountId}/role`,
        { roleId },
        csrfToken,
      );
      if (isStepUpCancelled(result)) return;
      if (result.ok) {
        onClose();
        notify({ tone: 'success', text: t('toast.change-role', { name }) });
        router.refresh();
        return;
      }
      const { failure } = result;
      if (failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      if (CHANGED_MEANWHILE.has(failure.code)) {
        onClose();
        notify({ tone: 'critical', text: messageFor(failure) });
        router.refresh();
        return;
      }
      setProblem(messageFor(failure));
    });
  }

  return (
    <Dialog
      open={open}
      title={t('dialog.change-role.title', { name })}
      onClose={() => {
        if (!flight.pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={flight.pending}>
            {t('dialog.keep')}
          </Button>
          <Button loading={flight.pending} onClick={() => void submit()}>
            {t('dialog.change-role.action')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <p>{t('dialog.change-role.body')}</p>
        <p className="text-sm text-fg-muted">
          {t('dialog.change-role.current', { role: roleLabel(root, current, roles) })}
        </p>
        <Select
          label={t('dialog.change-role.label')}
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          placeholder={t('dialog.change-role.placeholder')}
          options={options.filter((option) => option.value !== currentRoleId)}
          error={roleError ?? undefined}
        />
        {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      </form>
    </Dialog>
  );
}

/** Invite a team member with a role the actor may give. The same toast for any address. */
export function InviteMemberDialog({
  open,
  onClose,
  roles,
  csrfToken,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly roles: readonly SellerRole[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('identity.team');
  const root = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const messageFor = useFailureMessage();
  const flight = useSingleFlight();
  const callGuarded = useGuardedCall();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const options = useMemo(() => grantableOptions(root, roles), [root, roles]);

  useEffect(() => {
    if (!open) {
      setEmail('');
      setRoleId('');
      setEmailError(null);
      setRoleError(null);
      setProblem(null);
    }
  }, [open]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const address = email.trim();
    setEmailError(null);
    setRoleError(null);
    setProblem(null);
    if (address === '') {
      setEmailError(root('identity.error.validation.email.required'));
      return;
    }
    if (roleId === '') {
      setRoleError(t('dialog.invite.choose'));
      return;
    }
    await flight.run(async () => {
      const result = await callGuarded(
        'POST',
        'identity/seller/team/invitations',
        { email: address, roleId },
        csrfToken,
      );
      if (isStepUpCancelled(result)) return;
      if (result.ok) {
        onClose();
        notify({ tone: 'success', text: t('dialog.invite.toast-sent', { email: address }) });
        router.refresh();
        return;
      }
      const { failure } = result;
      if (failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      if (failure.code === 'validation.failed') {
        const fields = failure.details?.fields ?? [];
        if (fields.some((field) => field.path === 'email'))
          setEmailError(root('identity.error.validation.email.format'));
        else if (fields.some((field) => field.path === 'roleId'))
          setRoleError(t('dialog.invite.choose'));
        else setProblem(messageFor('unknown'));
        return;
      }
      if (
        failure.code === 'role.unknown' ||
        failure.code === 'role.not-grantable' ||
        failure.code === 'conflict.stale'
      )
        router.refresh();
      setProblem(messageFor(failure));
    });
  }

  return (
    <Dialog
      open={open}
      title={t('dialog.invite.title')}
      onClose={() => {
        if (!flight.pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={flight.pending}>
            {t('dialog.invite.cancel')}
          </Button>
          <Button loading={flight.pending} onClick={() => void submit()}>
            {t('dialog.invite.action')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <TextField
          label={root('identity.common.label.email')}
          type="email"
          name="email"
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={emailError ?? undefined}
        />
        <Select
          label={t('dialog.invite.label-role')}
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          placeholder={t('dialog.change-role.placeholder')}
          options={options}
          error={roleError ?? undefined}
        />
        <p className="text-sm text-fg-muted">{t('dialog.invite.help')}</p>
        {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      </form>
    </Dialog>
  );
}
