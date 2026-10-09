import { Badge, type BadgeTone } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { roleLabel } from './role-label.ts';
import { RowActions, type RowTarget } from './row-actions.tsx';
import type { AccountRow, InvitationRow, PlatformRole, TeamPage, TeamRow } from './types.ts';

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function statusOf(
  t: Translate,
  row: TeamRow,
): { readonly tone: BadgeTone; readonly label: string; readonly sent?: boolean } {
  if (row.type === 'invitation') {
    return row.status === 'expired'
      ? { tone: 'attention', label: t('identity.members.status.expired') }
      : { tone: 'neutral', label: t('identity.members.status.invited'), sent: true };
  }
  return row.status === 'active'
    ? { tone: 'success', label: t('identity.members.status.active') }
    : { tone: 'neutral', label: t('identity.members.status.deactivated') };
}

function Person({ t, row }: { readonly t: Translate; readonly row: AccountRow | InvitationRow }) {
  const name = row.type === 'account' ? row.displayName : null;
  return (
    <div className="min-w-0">
      <div className="break-words font-medium text-fg">
        {name ?? row.email}
        {row.type === 'account' && row.self ? (
          <span className="ms-2 text-xs font-normal text-fg-muted">
            {t('identity.members.label.you')}
          </span>
        ) : null}
      </div>
      {name === null ? null : <div className="break-words text-sm text-fg-muted">{row.email}</div>}
    </div>
  );
}

function targetOf(row: TeamRow): RowTarget {
  if (row.type === 'invitation') {
    return {
      kind: 'invitation',
      id: row.invitationId,
      name: row.email,
      hints: { resend: row.actions.resend, revoke: row.actions.revoke },
    };
  }
  return {
    kind: 'account',
    id: row.accountId,
    name: row.displayName ?? row.email,
    status: row.status,
    roleId: row.role?.roleId ?? null,
    hints: {
      changeRole: row.actions.changeRole,
      disable: row.actions.disable,
      enable: row.actions.enable,
      resetSecondFactor: row.actions.resetSecondFactor,
    },
  };
}

/** The Admins tab of B1: admin accounts and open invitations, read only (actions land with D2/D3). */
export async function TeamTable({
  page,
  after,
  csrfToken,
  roles,
}: {
  readonly page: TeamPage;
  readonly after: string | null;
  readonly csrfToken: string;
  /** Roles the actor may assign from; absent when they may not (Change role is hidden). */
  readonly roles?: readonly PlatformRole[] | undefined;
}) {
  const t = await getTranslations();
  if (page.items.length === 0 && after === null) {
    return (
      <div className="rounded-lg border border-line p-6">
        <h2 className="text-lg font-semibold">{t('identity.members.empty.title')}</h2>
        <p className="mt-1 text-fg-muted">{t('identity.members.empty.body')}</p>
      </div>
    );
  }
  if (page.items.length === 0) {
    return <p className="text-fg-muted">{t('identity.members.empty.page')}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-start text-sm">
        <caption className="sr-only">{t('identity.members.table-caption')}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('identity.members.label.person')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('identity.members.label.role')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('identity.members.label.status')}
            </th>
            <th scope="col" className="px-4 py-3 text-end font-medium">
              {t('identity.members.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {page.items.map((row) => {
            const status = statusOf(t, row);
            const id = row.type === 'account' ? row.accountId : row.invitationId;
            return (
              <tr key={`${row.type}-${id}`}>
                <td className="px-4 py-3">
                  <Person t={t} row={row} />
                </td>
                <td className="px-4 py-3">
                  {row.role?.kind === 'system' ? (
                    <span className="me-1" aria-hidden="true">
                      🔒
                    </span>
                  ) : null}
                  {roleLabel(t, row.role)}
                  {row.role?.kind === 'system' ? (
                    <span className="sr-only"> {t('identity.members.role.system')}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={status.tone}>
                    {status.sent === true ? (
                      <span className="me-1" aria-hidden="true">
                        ✉
                      </span>
                    ) : null}
                    {status.label}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-end">
                  <RowActions target={targetOf(row)} csrfToken={csrfToken} roles={roles} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
