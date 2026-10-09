import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RoleView } from '../../../../src/roles/role-view.tsx';
import { RolesNoAccess } from '../../../../src/roles/roles-page-gate.tsx';
import type { RoleCatalogue } from '../../../../src/roles/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';

const VIEW_PERMISSION = 'identity.platform-role.view';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.members.title.admin') };
}

export default async function RolePageRoute({
  params,
}: {
  readonly params: Promise<{ readonly roleId: string }>;
}) {
  const { roleId } = await params;
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
  if (result.kind !== 'ok') {
    return (
      <AdminShell session={gate.session} activeId="team" title={title}>
        <p className="text-fg-muted">{t('identity.error.unknown')}</p>
      </AdminShell>
    );
  }
  // Another Market's or an unknown id looks the same: not found (ux B5).
  const role = result.body.items.find((item) => item.roleId === roleId);
  if (role === undefined) notFound();
  return (
    <AdminShell session={gate.session} activeId="team" title={title}>
      <RoleView role={role} catalogue={result.body} />
    </AdminShell>
  );
}
