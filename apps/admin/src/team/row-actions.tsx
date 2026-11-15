'use client';

import { ConfirmAction, Menu, toast, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { ApiFailure } from '../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { ChangeRoleDialog } from './role-dialog.tsx';
import type { ActionHint, PlatformRole } from './types.ts';

/** What a row needs to act; plain data, built on the server from the team row. */
export type RowTarget =
  | {
      readonly kind: 'account';
      readonly id: string;
      readonly name: string;
      readonly status: 'active' | 'disabled';
      readonly roleId: string | null;
      readonly hints: {
        readonly changeRole: ActionHint;
        readonly disable: ActionHint;
        readonly enable: ActionHint;
        readonly resetSecondFactor: ActionHint;
      };
    }
  | {
      readonly kind: 'invitation';
      readonly id: string;
      readonly name: string;
      readonly hints: { readonly resend: ActionHint; readonly revoke: ActionHint };
    };

/** Answers that mean the list is out of date: the dialog closes and the list is reloaded. */
const CHANGED_MEANWHILE: ReadonlySet<string> = new Set([
  'conflict.stale',
  'account.unknown',
  'account.already-disabled',
  'account.already-active',
  'invitation.unknown',
  'invitation.rejected',
]);

type ActionId = 'deactivate' | 'reactivate' | 'reset-two-step' | 'resend' | 'cancel-invitation';

interface ActionDef {
  readonly id: ActionId;
  readonly hint: ActionHint;
  readonly path: string;
  /** Needs a confirmation dialog (D3); the others act at once. */
  readonly confirm: boolean;
  readonly critical: boolean;
  /** 3 = security or irreversible: the person types the row's name, and a step-up code may follow. */
  readonly level: 2 | 3;
}

function definitionsFor(target: RowTarget): readonly ActionDef[] {
  if (target.kind === 'invitation') {
    return [
      {
        id: 'resend',
        hint: target.hints.resend,
        path: `identity/admin/invitations/${target.id}/resend`,
        confirm: false,
        critical: false,
        level: 2,
      },
      {
        id: 'cancel-invitation',
        hint: target.hints.revoke,
        path: `identity/admin/invitations/${target.id}/revoke`,
        confirm: true,
        critical: true,
        level: 2,
      },
    ];
  }
  return [
    {
      id: 'reset-two-step',
      hint: target.hints.resetSecondFactor,
      path: `identity/admin/accounts/${target.id}/second-factor/reset`,
      confirm: true,
      critical: false,
      level: 3,
    },
    target.status === 'active'
      ? {
          id: 'deactivate',
          hint: target.hints.disable,
          path: `identity/admin/accounts/${target.id}/disable`,
          confirm: true,
          critical: true,
          level: 2,
        }
      : {
          id: 'reactivate',
          hint: target.hints.enable,
          path: `identity/admin/accounts/${target.id}/enable`,
          confirm: false,
          critical: false,
          level: 2,
        },
  ];
}

/** The row menu of B1 with the D3 confirmation (ux 3.3). The server checks every command again. */
export function RowActions({
  target,
  csrfToken,
  roles,
}: {
  readonly target: RowTarget;
  readonly csrfToken: string;
  /** Present only when the actor may assign roles and the list loaded; absent hides Change role. */
  readonly roles?: readonly PlatformRole[] | undefined;
}) {
  const t = useTranslations('identity.members');
  const te = useTranslations('identity');
  const router = useRouter();
  const callGuarded = useGuardedCall();
  const [asking, setAsking] = useState<ActionDef | null>(null);
  const [changingRole, setChangingRole] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, not only state: a second click must not start a second request before a render.
  const inFlight = useRef(false);

  const messageFor = (code: string): string => {
    if (t.has(`reason.${code}`)) return t(`reason.${code}`);
    if (te.has(`error.${code}`)) return te(`error.${code}`);
    return te('error.unknown');
  };

  async function run(action: ActionDef) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const result = await callGuarded('POST', action.path, {}, csrfToken);
    inFlight.current = false;
    setPending(false);
    if (isStepUpCancelled(result)) return;
    if (result.ok) {
      setAsking(null);
      toast.success(t(`toast.${action.id}`, { name: target.name }));
      router.refresh();
      return;
    }
    const failure: ApiFailure = result.failure;
    if (failure.status === 401) {
      router.replace('/session-ended');
      return;
    }
    if (CHANGED_MEANWHILE.has(failure.code)) {
      // The row changed or went away meanwhile: close, say so, and show it as it is now.
      setAsking(null);
      toast.error(messageFor(failure.code));
      router.refresh();
      return;
    }
    if (action.confirm) setProblem(messageFor(failure.code));
    else toast.error(messageFor(failure.code));
  }

  const items: MenuItem[] = definitionsFor(target).map((action) => ({
    id: action.id,
    label: t(`action.${action.id}`),
    disabled: !action.hint.allowed || pending,
    ...(action.hint.allowed ? {} : { reason: messageFor(action.hint.code ?? 'unknown') }),
    ...(action.critical ? { tone: 'critical' as const } : {}),
    onSelect: () => {
      if (action.confirm) {
        setProblem(null);
        setAsking(action);
      } else void run(action);
    },
  }));

  if (target.kind === 'account' && roles !== undefined) {
    items.unshift({
      id: 'change-role',
      label: t('action.change-role'),
      disabled: !target.hints.changeRole.allowed,
      ...(target.hints.changeRole.allowed
        ? {}
        : { reason: messageFor(target.hints.changeRole.code ?? 'unknown') }),
      onSelect: () => setChangingRole(true),
    });
  }

  return (
    <>
      {target.kind === 'account' && roles !== undefined ? (
        <ChangeRoleDialog
          open={changingRole}
          onClose={() => setChangingRole(false)}
          accountId={target.id}
          name={target.name}
          currentRoleId={target.roleId}
          roles={roles}
          csrfToken={csrfToken}
        />
      ) : null}
      <Menu label={t('actions-for', { name: target.name })} items={items} />
      <ConfirmAction
        open={asking !== null}
        level={asking?.level ?? 2}
        title={asking === null ? '' : t(`dialog.${asking.id}.title`, { name: target.name })}
        body={asking === null ? null : <p>{t(`dialog.${asking.id}.body`)}</p>}
        rowName={target.name}
        typeLabel={t('dialog.type-to-confirm')}
        stepUpNote={asking?.level === 3 ? t('dialog.step-up-note') : undefined}
        confirmLabel={asking === null ? '' : t(`dialog.${asking.id}.action`)}
        cancelLabel={t(
          asking?.id === 'cancel-invitation' ? 'dialog.keep-invitation' : 'dialog.keep',
        )}
        pending={pending}
        error={problem}
        onConfirm={() => {
          if (asking !== null) void run(asking);
        }}
        onCancel={() => setAsking(null)}
      />
    </>
  );
}
