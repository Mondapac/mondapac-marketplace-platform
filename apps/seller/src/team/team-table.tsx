import {
  Badge,
  CARD_TABLE,
  EmailText,
  EmptyState,
  Icon,
  type BadgeTone,
  MemberColumns,
} from '@mondapac/ui';
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server';
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
        {name ?? <EmailText address={row.email} />}
        {row.type === 'account' && row.self ? (
          <span className="ms-2 text-xs font-normal text-fg-muted">
            {t('identity.team.label.you')}
          </span>
        ) : null}
      </div>
      {name === null ? null : (
        <div className="break-words text-sm text-fg-muted">
          <EmailText address={row.email} />
        </div>
      )}
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
  const locale = await getLocale();
  const zone = await getTimeZone();
  if (page.items.length === 0 && after === null) {
    return (
      <EmptyState
        icon="users"
        title={t('identity.team.empty.title')}
        body={t('identity.team.empty.body')}
      />
    );
  }
  if (page.items.length === 0) {
    return <p className="text-fg-muted">{t('identity.team.empty.page')}</p>;
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-160 lg:table-fixed`}>
        <caption className="sr-only">{t('identity.team.table-caption')}</caption>
        <MemberColumns />
        <thead className={CARD_TABLE.head}>
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
        <tbody className={CARD_TABLE.body}>
          {page.items.map((row) => {
            const status = statusOf(t, row);
            const id = row.type === 'account' ? row.accountId : row.invitationId;
            return (
              <tr key={`${row.type}-${id}`} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  <Person t={t} row={row} />
                </td>
                <td
                  className={`${CARD_TABLE.labelled} break-words`}
                  data-label={t('identity.team.label.role')}
                >
                  <span className="inline-flex min-w-0 items-center gap-(--mp-space-1-5)">
                    {row.role?.kind === 'system' ? (
                      <Icon name="lock" className="text-icon-muted" />
                    ) : null}
                    {roleLabel(t, row.role, roleList)}
                    {row.role?.kind === 'system' ? (
                      <span className="sr-only"> {t('identity.team.role.system')}</span>
                    ) : null}
                  </span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('identity.team.label.status')}>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {row.type === 'invitation' && row.expiresAt !== null ? (
                    <div className="mt-1 text-xs text-fg-muted">
                      {t(
                        row.status === 'expired'
                          ? 'identity.team.expired-on'
                          : 'identity.team.expires-on',
                        { when: formatInstant(row.expiresAt, locale, zone) },
                      )}
                    </div>
                  ) : null}
                </td>
                <td className={`${CARD_TABLE.corner} text-end`}>
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
