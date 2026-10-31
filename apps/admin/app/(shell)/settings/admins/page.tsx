import { LoadError, NoAccess, SettingsPage, SettingsSection } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { InviteAdminButton } from '../../../../src/team/invite-admin-button.tsx';
import { TeamTable } from '../../../../src/team/team-table.tsx';
import type { PlatformRole, TeamPage } from '../../../../src/team/types.ts';

const VIEW_PERMISSION = 'identity.admin-account.view';
const ROLES_PERMISSION = 'identity.platform-role.view';
const ASSIGN_PERMISSION = 'identity.platform-role.assign';
const INVITE_PERMISSION = 'identity.admin-account.invite';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.hub.link.admins') };
}

export default async function TeamPageRoute({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <SettingsShell session={gate.session} linkId="admins" title={t('settings.hub.link.admins')}>
        <NoAccess
          title={t('identity.members.no-access.title')}
          body={t('identity.members.no-access.body')}
          backHref="/settings"
          backLabel={t('settings.sub.back')}
        />
      </SettingsShell>
    );
  }
  const { after: rawAfter } = await searchParams;
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  const title = t('settings.hub.link.admins');
  // Each action shows only to an actor who holds its key; the server checks every command again.
  const keys = new Set(gate.session.permissionKeys);
  const canAssign = keys.has(ASSIGN_PERMISSION);
  const canInvite = keys.has(INVITE_PERMISSION);
  const needsRoles = keys.has(ROLES_PERMISSION) && (canAssign || canInvite);
  const [result, rolesResult] = await Promise.all([
    serverGet<TeamPage>(`identity/admin/team${after === null ? '' : `?after=${after}`}`),
    needsRoles
      ? serverGet<{ readonly items: readonly PlatformRole[] }>('identity/admin/roles')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out' || rolesResult?.kind === 'signed-out') {
    redirect('/session-ended');
  }
  // Without the role list the role actions are left out, not shown broken.
  const roles = rolesResult?.kind === 'ok' ? rolesResult.body.items : undefined;
  return (
    <SettingsShell session={gate.session} linkId="admins" title={title}>
      <SettingsPage
        title={title}
        description={t('settings.admins.description')}
        actions={
          result.kind === 'ok' && canInvite && roles !== undefined ? (
            <InviteAdminButton roles={roles} csrfToken={gate.session.csrfToken} />
          ) : null
        }
      >
        <SettingsSection title={t('settings.admins.section')}>
          {result.kind === 'ok' ? (
            <>
              <TeamTable
                page={result.body}
                after={after}
                csrfToken={gate.session.csrfToken}
                roles={canAssign ? roles : undefined}
              />
              {result.body.next === null || !UUID.test(result.body.next) ? null : (
                <p className="border-t border-line-row px-5 py-4">
                  <a
                    className="font-medium text-link underline"
                    href={`/settings/admins?after=${result.body.next}`}
                  >
                    {t('identity.members.next-page')}
                  </a>
                </p>
              )}
            </>
          ) : (
            <div className="px-5 py-4">
              <LoadError
                message={t('identity.error.unknown')}
                retryLabel={t('load.retry')}
                className="flex flex-col items-start gap-3"
              />
            </div>
          )}
        </SettingsSection>
      </SettingsPage>
    </SettingsShell>
  );
}
