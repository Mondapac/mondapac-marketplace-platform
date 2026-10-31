import { LinkButton, LoadError, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RolesNoAccess } from '../../../../src/roles/roles-page-gate.tsx';
import { memberCounts } from '../../../../src/roles/member-counts.ts';
import { RolesTable } from '../../../../src/roles/roles-table.tsx';
import type { RoleCatalogue } from '../../../../src/roles/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

const VIEW_PERMISSION = 'identity.platform-role.view';
const TEAM_PERMISSION = 'identity.admin-account.view';
const CREATE_PERMISSION = 'identity.platform-role.create';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.members.title.admin') };
}

export default async function RolesPageRoute() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return <RolesNoAccess session={gate.session} />;
  }
  const [result, members] = await Promise.all([
    serverGet<RoleCatalogue>('identity/admin/roles'),
    gate.session.permissionKeys.includes(TEAM_PERMISSION) ? memberCounts() : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const title = t('identity.members.title.admin');
  return (
    <SettingsShell session={gate.session} linkId="roles" title={title}>
      <SettingsPage
        title={title}
        description={t('settings.roles.description')}
        actions={
          gate.session.permissionKeys.includes(CREATE_PERMISSION) ? (
            <LinkButton href="/settings/roles/new">{t('identity.roles.action.create')}</LinkButton>
          ) : null
        }
      >
        {result.kind === 'ok' ? (
          <RolesTable roles={result.body.items} members={members} />
        ) : (
          <LoadError
            title={t('settings.load-error.title', { page: title })}
            message={t('settings.load-error.body')}
            retryLabel={t('load.retry')}
            className="w-full"
          />
        )}
      </SettingsPage>
    </SettingsShell>
  );
}
