'use client';

import { Banner, Button, Dialog, Menu, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import type { ActionHint } from './types.ts';
import { useNotice } from './notice.tsx';

/** What a row needs to act; plain data, built on the server from the team row. */
export type RowTarget =
  | {
      readonly kind: 'account';
      readonly id: string;
      readonly name: string;
      readonly status: 'active' | 'disabled';
      readonly hints: {
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

function definitionsFor(target: RowTarget): readonly ActionDef[] {
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
          confirm: false,
          critical: false,
        },
  ];
}

/** The row menu of B1 with the D3 confirmation (ux 3.3). The server checks every command again. */
export function RowActions({
  target,
  csrfToken,
}: {
  readonly target: RowTarget;
  readonly csrfToken: string;
}) {
  const t = useTranslations('identity.members');
  const te = useTranslations('identity');
  const router = useRouter();
  const notify = useNotice();
  const [asking, setAsking] = useState<ActionDef | null>(null);
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
    const result = await callApi('POST', action.path, {}, csrfToken);
    inFlight.current = false;
    setPending(false);
    if (result.ok) {
      setAsking(null);
      notify({ tone: 'success', text: t(`toast.${action.id}`, { name: target.name }) });
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
      notify({ tone: 'critical', text: messageFor(failure.code) });
      router.refresh();
      return;
    }
    if (action.confirm) setProblem(messageFor(failure.code));
    else notify({ tone: 'critical', text: messageFor(failure.code) });
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

  return (
    <>
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
        {problem === null ? null : (
          <div className="mt-3">
            <Banner tone="critical">{problem}</Banner>
          </div>
        )}
      </Dialog>
    </>
  );
}
