'use client';

import { Banner, Button, Dialog, Menu, toast, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
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
}

function definitionsFor(target: RowTarget, reviewed: boolean): readonly ActionDef[] {
  if (target.kind === 'invitation') {
    return [
      {
        id: 'resend',
        hint: target.hints.resend,
        path: `identity/admin/invitations/${target.id}/resend`,
        confirm: false,
        critical: false,
      },
      {
        id: 'cancel-invitation',
        hint: target.hints.revoke,
        path: `identity/admin/invitations/${target.id}/revoke`,
        confirm: true,
        critical: true,
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
    },
    target.status === 'active'
      ? {
          id: 'deactivate',
          hint: target.hints.disable,
          path: `identity/admin/accounts/${target.id}/disable`,
          confirm: true,
          critical: true,
        }
      : {
          id: 'reactivate',
          hint: target.hints.enable,
          path: `identity/admin/accounts/${target.id}/enable`,
          // Reviewed: a dialog asks for the note first.
          confirm: reviewed,
          critical: false,
        },
  ];
}

/** The row menu of B1 with the D3 confirmation (ux 3.3). The server checks every command again. */
export function RowActions({
  target,
  csrfToken,
  roles,
  reviewed = false,
}: {
  readonly target: RowTarget;
  /** The Market reviews people changes: a role change and a reactivation need a note. */
  readonly reviewed?: boolean;
  readonly csrfToken: string;
  /** Present only when the actor may assign roles and the list loaded; absent hides Change role. */
  readonly roles?: readonly PlatformRole[] | undefined;
}) {
  const t = useTranslations('identity.members');
  const te = useTranslations('identity');
  const router = useRouter();
  const [asking, setAsking] = useState<ActionDef | null>(null);
  const [changingRole, setChangingRole] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const sentForReview = useSentForReview();
  // A ref, not only state: a second click must not start a second request before a render.
  const inFlight = useRef(false);

  const messageFor = (code: string): string => {
    if (t.has(`reason.${code}`)) return t(`reason.${code}`);
    if (te.has(`error.${code}`)) return te(`error.${code}`);
    return te('error.unknown');
  };

  async function run(action: ActionDef) {
    if (inFlight.current) return;
    // Only a reviewed reactivation carries a note; a deactivation opens no request and sends none.
    const noted = reviewed && action.id === 'reactivate';
    const sentNote = noted ? trimmedNote(note) : null;
    setNoteError(null);
    if (noted && sentNote === null) {
      setNoteError('required');
      return;
    }
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>(
      'POST',
      action.path,
      sentNote === null ? {} : { note: sentNote },
      csrfToken,
    );
    inFlight.current = false;
    setPending(false);
    if (result.ok) {
      setAsking(null);
      setNote('');
      toast.success(t(`toast.${action.id}`, { name: target.name }));
      sentForReview(result.body);
      router.refresh();
      return;
    }
    const failure: ApiFailure = result.failure;
    if (failure.status === 401) {
      router.replace('/session-ended');
      return;
    }
    if (noted && isNoteFailure(failure)) {
      setNoteError(note.trim() === '' ? 'required' : 'rejected');
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

  const items: MenuItem[] = definitionsFor(target, reviewed).map((action) => ({
    id: action.id,
    label: t(`action.${action.id}`),
    disabled: !action.hint.allowed || pending,
    ...(action.hint.allowed ? {} : { reason: messageFor(action.hint.code ?? 'unknown') }),
    ...(action.critical ? { tone: 'critical' as const } : {}),
    onSelect: () => {
      if (action.confirm) {
        setProblem(null);
        setNote('');
        setNoteError(null);
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
          reviewed={reviewed}
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
              {t(asking?.id === 'cancel-invitation' ? 'dialog.keep-invitation' : 'dialog.keep')}
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
        {asking?.id === 'reactivate' ? (
          <div className="mt-3">
            <ReviewNoteField
              value={note}
              onChange={setNote}
              error={noteError ?? undefined}
              disabled={pending}
            />
          </div>
        ) : null}
        {problem === null ? null : (
          <div className="mt-3">
            <Banner tone="critical">{problem}</Banner>
          </div>
        )}
      </Dialog>
    </>
  );
}
