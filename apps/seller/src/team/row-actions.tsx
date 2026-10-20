'use client';

import { Banner, Button, Dialog, Menu, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { useNotice } from './notice.tsx';
import { ChangeRoleDialog } from './role-dialog.tsx';
import type { ActionHint, SellerRole } from './types.ts';
import { useFailureMessage } from './use-team.ts';

/** What a row needs to act; plain data, built on the server from the team row. */
export type RowTarget =
  | {
      readonly kind: 'account';
      readonly id: string;
      readonly name: string;
      readonly roleId: string | null;
      readonly hints: { readonly changeRole: ActionHint; readonly remove: ActionHint };
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
  'invitation.unknown',
  'invitation.rejected',
]);

type ActionId = 'remove' | 'resend' | 'revoke';

interface ActionDef {
  readonly id: ActionId;
  readonly hint: ActionHint;
  readonly path: string;
  /** Needs a confirmation dialog; the others act at once. */
  readonly confirm: boolean;
  readonly critical: boolean;
}

function definitionsFor(target: RowTarget): readonly ActionDef[] {
  const base = 'identity/seller/team';
  if (target.kind === 'invitation') {
    return [
      {
        id: 'resend',
        hint: target.hints.resend,
        path: `${base}/invitations/${target.id}/resend`,
        confirm: false,
        critical: false,
      },
      {
        id: 'revoke',
        hint: target.hints.revoke,
        path: `${base}/invitations/${target.id}/revoke`,
        confirm: true,
        critical: true,
      },
    ];
  }
  return [
    {
      id: 'remove',
      hint: target.hints.remove,
      path: `${base}/accounts/${target.id}/remove`,
      confirm: true,
      critical: true,
    },
  ];
}

/** The row menu with the confirmation for the destructive actions. The server checks again. */
export function RowActions({
  target,
  csrfToken,
  roles,
}: {
  readonly target: RowTarget;
  readonly csrfToken: string;
  /** Present only when the actor may assign roles and the list loaded; absent hides Change role. */
  readonly roles?: readonly SellerRole[] | undefined;
}) {
  const t = useTranslations('identity.team');
  const router = useRouter();
  const notify = useNotice();
  const messageFor = useFailureMessage();
  const callGuarded = useGuardedCall();
  const [asking, setAsking] = useState<ActionDef | null>(null);
  const [changingRole, setChangingRole] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, not only state: a second click must not start a second request before a render.
  const inFlight = useRef(false);

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
      notify({ tone: 'success', text: t(`toast.${action.id}`, { name: target.name }) });
      router.refresh();
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      router.replace('/session-ended');
      return;
    }
    if (CHANGED_MEANWHILE.has(failure.code)) {
      // The row changed or went away meanwhile: close, say so, and show it as it is now.
      setAsking(null);
      notify({ tone: 'critical', text: messageFor(failure) });
      router.refresh();
      return;
    }
    if (action.confirm) setProblem(messageFor(failure));
    else notify({ tone: 'critical', text: messageFor(failure) });
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
      <Dialog
        open={asking !== null}
        title={asking === null ? '' : t(`dialog.${asking.id}.title`, { name: target.name })}
        onClose={() => {
          if (!pending) setAsking(null);
        }}
        actions={
          <>
            <Button variant="secondary" onClick={() => setAsking(null)} disabled={pending}>
              {t(asking?.id === 'revoke' ? 'dialog.keep-invitation' : 'dialog.keep')}
            </Button>
            <Button
              variant={asking?.critical === true ? 'destructive' : 'primary'}
              loading={pending}
              onClick={() => {
                if (asking !== null) void run(asking);
              }}
            >
              {asking === null ? '' : t(`dialog.${asking.id}.action`)}
            </Button>
          </>
        }
      >
        {asking === null ? null : <p>{t(`dialog.${asking.id}.body`)}</p>}
        {problem === null ? null : (
          <div className="mt-3">
            <Banner tone="critical">{problem}</Banner>
          </div>
        )}
      </Dialog>
    </>
  );
}
