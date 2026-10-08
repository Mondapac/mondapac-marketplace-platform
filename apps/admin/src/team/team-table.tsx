import { Badge, type BadgeTone } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { AccountRow, InvitationRow, TeamPage, TeamRole, TeamRow } from './types.ts';

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function roleLabel(t: Translate, role: TeamRole | null): string {
  if (role === null) return t('identity.members.role.none');
  const key = `identity.role.${role.seedCode ?? ''}`;
  if (role.seedCode !== null && t.has(key)) return t(key);
  return t('identity.members.role.custom');
}

function statusOf(
  t: Translate,
  row: TeamRow,
): { readonly tone: BadgeTone; readonly label: string } {
  if (row.type === 'invitation') {
    return row.status === 'expired'
      ? { tone: 'attention', label: t('identity.members.status.expired') }
      : { tone: 'info', label: t('identity.members.status.invited') };
  }
  return row.status === 'active'
    ? { tone: 'success', label: t('identity.members.status.active') }
    : { tone: 'neutral', label: t('identity.members.status.deactivated') };
}

function Person({ t, row }: { readonly t: Translate; readonly row: AccountRow | InvitationRow }) {
  const name = row.type === 'account' ? row.displayName : null;
  return (
    <div className="min-w-0">
      <div className="truncate font-medium text-fg">
        {name ?? row.email}
        {row.type === 'account' && row.self ? (
          <span className="ms-2 text-xs font-normal text-fg-muted">
            {t('identity.members.label.you')}
          </span>
        ) : null}
      </div>
      {name === null ? null : <div className="truncate text-sm text-fg-muted">{row.email}</div>}
    </div>
  );
}

/** The Admins tab of B1: admin accounts and open invitations, read only (actions land with D2/D3). */
export async function TeamTable({
  page,
  after,
}: {
  readonly page: TeamPage;
  readonly after: string | null;
}) {
  const t = await getTranslations();
  if (page.items.length === 0 && after === null) {
    return (
      <div className="rounded-lg border border-border p-6">
        <h2 className="text-lg font-semibold">{t('identity.members.empty.title')}</h2>
        <p className="mt-1 text-fg-muted">{t('identity.members.empty.body')}</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-start text-sm">
        <caption className="sr-only">{t('identity.members.table-caption')}</caption>
        <thead className="bg-surface-muted text-fg-muted">
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
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
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
                  <Badge tone={status.tone}>{status.label}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
