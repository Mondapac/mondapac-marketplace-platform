import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RolesNoAccess } from '../../../src/roles/roles-page-gate.tsx';
import { RolesTable } from '../../../src/roles/roles-table.tsx';
import type { RoleCatalogue } from '../../../src/roles/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { TeamTabs, tabLabels } from '../../../src/team/team-tabs.tsx';

const VIEW_PERMISSION = 'identity.platform-role.view';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.members.title.admin') };
}

export default async function RolesPageRoute() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return <RolesNoAccess session={gate.session} />;
  }
  const result = await serverGet<RoleCatalogue>('identity/admin/roles');
  if (result.kind === 'signed-out') redirect('/session-ended');
  const title = t('identity.members.title.admin');
  return (
    <AdminShell session={gate.session} activeId="team" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <TeamTabs active="roles" labels={tabLabels(t)} />
      {result.kind === 'ok' ? (
        <RolesTable roles={result.body.items} />
      ) : (
        <p className="text-fg-muted">{t('identity.error.unknown')}</p>
      )}
    </AdminShell>
  );
}
