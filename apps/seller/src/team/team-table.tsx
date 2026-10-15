import { Badge, type BadgeTone } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { formatInstant } from '../catalog/format.ts';
import { roleLabel } from './role-label.ts';
import { RowActions, type RowTarget } from './row-actions.tsx';
import type { InvitationRow, MemberRow, SellerRole, TeamPage, TeamRow } from './types.ts';

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function statusOf(t: Translate, row: TeamRow): { tone: BadgeTone; label: string } {
  if (row.type === 'invitation') {
    return row.status === 'expired'
      ? { tone: 'attention', label: t('identity.team.status.expired') }
      : { tone: 'neutral', label: t('identity.team.status.invited') };
  }
  return { tone: 'success', label: t('identity.team.status.active') };
}

function Person({ t, row }: { readonly t: Translate; readonly row: MemberRow | InvitationRow }) {
  const name = row.type === 'account' ? row.displayName : null;
  return (
    <div className="min-w-0">
      <div className="break-words font-medium text-fg">
        {name ?? row.email}
        {row.type === 'account' && row.self ? (
          <span className="ms-2 text-xs font-normal text-fg-muted">
            {t('identity.team.label.you')}
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
    roleId: row.role?.roleId ?? null,
    hints: { changeRole: row.actions.changeRole, remove: row.actions.remove },
  };
}

/** The team: members and open invitations, with the row actions the server's hints allow. */
export async function TeamTable({
  page,
  after,
  csrfToken,
  roles,
  roleList = [],
}: {
  readonly page: TeamPage;
  readonly after: string | null;
  readonly csrfToken: string;
  /** Roles the actor may assign from; absent when they may not (Change role is hidden). */
  readonly roles?: readonly SellerRole[] | undefined;
  /** Every role the actor may read, to name custom roles in the list. */
  readonly roleList?: readonly SellerRole[];
}) {
  const t = await getTranslations();
  if (page.items.length === 0 && after === null) {
    return (
      <div className="rounded-lg border border-line p-6">
        <h2 className="text-lg font-semibold">{t('identity.team.empty.title')}</h2>
        <p className="mt-1 text-fg-muted">{t('identity.team.empty.body')}</p>
      </div>
    );
  }
  if (page.items.length === 0) {
    return <p className="text-fg-muted">{t('identity.team.empty.page')}</p>;
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className="w-full table-fixed text-start text-sm md:min-w-160 max-md:block">
        <caption className="sr-only">{t('identity.team.table-caption')}</caption>
        <colgroup className="max-md:hidden">
          <col />
          <col className="w-44" />
          <col className="w-44" />
          <col className="w-24" />
        </colgroup>
        <thead className="bg-muted text-fg-muted max-md:sr-only">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('identity.team.label.person')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('identity.team.label.role')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('identity.team.label.status')}
            </th>
            <th scope="col" className="px-4 py-3 text-end font-medium">
              {t('identity.team.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row max-md:block">
          {page.items.map((row) => {
            const status = statusOf(t, row);
            const id = row.type === 'account' ? row.accountId : row.invitationId;
            return (
              <tr
                key={`${row.type}-${id}`}
                className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-3 max-md:gap-y-2 max-md:p-4"
              >
                <td className="px-4 py-3 align-middle max-md:p-0">
                  <Person t={t} row={row} />
                </td>
                <td
                  className="break-words px-4 py-3 align-middle max-md:col-span-2 max-md:p-0 max-md:before:me-2 max-md:before:inline-block max-md:before:w-20 max-md:before:align-top max-md:before:text-fg-muted max-md:before:content-[attr(data-label)]"
                  data-label={t('identity.team.label.role')}
                >
                  {row.role?.kind === 'system' ? (
                    <span className="me-1" aria-hidden="true">
                      🔒
                    </span>
                  ) : null}
                  {roleLabel(t, row.role, roleList)}
                  {row.role?.kind === 'system' ? (
                    <span className="sr-only"> {t('identity.team.role.system')}</span>
                  ) : null}
                </td>
                <td
                  className="px-4 py-3 align-middle max-md:col-span-2 max-md:p-0 max-md:before:me-2 max-md:before:inline-block max-md:before:w-20 max-md:before:align-top max-md:before:text-fg-muted max-md:before:content-[attr(data-label)]"
                  data-label={t('identity.team.label.status')}
                >
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {row.type === 'invitation' && row.expiresAt !== null ? (
                    <div className="mt-1 text-xs text-fg-muted">
                      {t(
                        row.status === 'expired'
                          ? 'identity.team.expired-on'
                          : 'identity.team.expires-on',
                        { when: formatInstant(row.expiresAt) },
                      )}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-end align-middle max-md:col-start-2 max-md:row-start-1 max-md:p-0">
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
