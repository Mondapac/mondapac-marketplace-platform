'use client';

import { Button, ConfirmAction, Select, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import type { GroupRef, MembersChange } from './groups-types.ts';

export type MembersAction = 'add' | 'remove';

/** Who the change is for: ticked ids, or the list's selector ("select all matching"). */
export type MembersTarget =
  | { readonly ids: readonly string[] }
  | {
      readonly selector: {
        readonly view: string;
        readonly q?: string;
        readonly filters?: Readonly<Record<string, unknown>>;
      };
    };

/** The message key (under `customers.groups.error`) of a refused members change. */
export function membersProblemOf(failure: ApiFailure): string {
  switch (failure.code) {
    case 'customers.group-not-found':
      return 'not-found';
    case 'customers.group-archived':
      return 'archived';
    case 'batch.too-large':
      return 'too-large';
    case 'access.denied':
      return 'denied';
    case 'request.csrf':
      return 'csrf';
    default:
      return failure.status === 403 ? 'denied' : 'unavailable';
  }
}

/** Sends one members change; the toast says how many changed and how many were skipped. */
export async function changeMembers(
  action: MembersAction,
  groupId: string,
  target: MembersTarget,
  csrfToken: string,
): Promise<
  | { readonly ok: true; readonly body: MembersChange }
  | { readonly ok: false; readonly failure: ApiFailure }
> {
  const body = 'ids' in target ? { ids: target.ids } : target.selector;
  const id = encodeURIComponent(groupId);
  const result =
    action === 'add'
      ? await callApi<MembersChange>(
          'POST',
          `customers/admin/groups/${id}/members/add`,
          body,
          csrfToken,
        )
      : await callApi<MembersChange>(
          'POST',
          `customers/admin/groups/${id}/members/remove`,
          body,
          csrfToken,
        );
  return result.ok ? { ok: true, body: result.body } : { ok: false, failure: result.failure };
}

/**
 * Add to group… and Remove from group… of the Customers list's Bulk menu and of the customer
 * page (customers management phase 2a, key `customers.groups.manage`): pick the group (unless
 * the page fixes it), see how many customers it is for, confirm (level 2). The answer says how
 * many were added or removed and how many were skipped (already in, or not in). An archived group
 * takes no new members, so Add offers live groups only.
 */
export function GroupMembersDialog({
  action,
  count,
  groups,
  groupsFailed = false,
  onRetryGroups,
  fixedGroup,
  target,
  csrfToken,
  onClose,
  onDone,
}: {
  /** Null closes the dialog. */
  readonly action: MembersAction | null;
  /** How many customers the change is for, as the list counts them. */
  readonly count: number;
  /** The groups to pick from; null while they are read. */
  readonly groups: readonly GroupRef[] | null;
  /** The groups could not be read: an error with Retry instead of the picker. */
  readonly groupsFailed?: boolean;
  readonly onRetryGroups?: () => void;
  /** A group page's own group, or the chip's group on the customer page: no picker. */
  readonly fixedGroup: GroupRef | null;
  readonly target: MembersTarget;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (change: MembersChange) => void;
}) {
  const t = useTranslations('customers.groups');
  const [picked, setPicked] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (action === null) {
      setPicked('');
      setError(null);
    }
  }, [action]);

  const choices = (groups ?? []).filter((group) => action !== 'add' || !group.archived);
  const groupId = fixedGroup?.groupId ?? picked;
  const groupName =
    fixedGroup?.name ?? choices.find((group) => group.groupId === picked)?.name ?? '';

  async function confirm() {
    if (action === null || busy.current) return;
    if (groupId === '') {
      setError(t('error.pick'));
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await changeMembers(action, groupId, target, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      const skipped = Math.max(result.body.requested - result.body.changed, 0);
      toast.success(
        t(action === 'add' ? 'added' : 'removed', {
          count: result.body.changed,
          skipped,
          name: groupName,
        }),
        { id: 'customers-group-members' },
      );
      onDone(result.body);
      onClose();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(
      t(`error.${membersProblemOf(result.failure)}`, {
        max: result.failure.details?.max ?? 0,
        total: result.failure.details?.total ?? 0,
      }),
    );
  }

  const adding = action === 'add';
  return (
    <ConfirmAction
      open={action !== null}
      level={2}
      title={t(adding ? 'add-title' : 'remove-title', { count })}
      body={
        <div className="flex flex-col gap-3">
          {fixedGroup === null ? (
            groupsFailed ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-critical-fg">{t('groups-failed')}</span>
                {onRetryGroups === undefined ? null : (
                  <Button variant="secondary" onClick={onRetryGroups}>
                    {t('retry')}
                  </Button>
                )}
              </div>
            ) : choices.length === 0 ? (
              <p className="text-fg-muted">{groups === null ? t('loading') : t('none-to-pick')}</p>
            ) : (
              <Select
                label={t('pick')}
                value={picked}
                placeholder={t('pick-placeholder')}
                options={choices.map((group) => ({
                  value: group.groupId,
                  label: group.archived ? t('archived-name', { name: group.name }) : group.name,
                }))}
                onChange={(event) => {
                  setPicked(event.target.value);
                  setError(null);
                }}
              />
            )
          ) : null}
          <p className="wrap-anywhere">
            {groupName === ''
              ? t(adding ? 'add-body-unpicked' : 'remove-body-unpicked', { count })
              : t(adding ? 'add-body' : 'remove-body', { count, name: groupName })}
          </p>
        </div>
      }
      rowName={groupName}
      confirmLabel={t(adding ? 'add-confirm' : 'remove-confirm')}
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
