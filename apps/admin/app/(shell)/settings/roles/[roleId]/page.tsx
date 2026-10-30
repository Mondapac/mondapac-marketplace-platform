import { LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RoleEditor } from '../../../../../src/roles/role-editor.tsx';
import { RoleView } from '../../../../../src/roles/role-view.tsx';
import { RolesNoAccess } from '../../../../../src/roles/roles-page-gate.tsx';
import type { RoleCatalogue } from '../../../../../src/roles/types.ts';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { SettingsShell } from '../../../../../src/server/settings-shell.tsx';

const VIEW_PERMISSION = 'identity.platform-role.view';
const EDIT_PERMISSION = 'identity.platform-role.edit';
const CREATE_PERMISSION = 'identity.platform-role.create';

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
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return <RolesNoAccess session={gate.session} />;
  }
  const result = await serverGet<RoleCatalogue>('identity/admin/roles');
  if (result.kind === 'signed-out') redirect('/session-ended');
  const title = t('identity.members.title.admin');
  if (result.kind !== 'ok') {
    return (
      <SettingsShell session={gate.session} linkId="roles" title={title} nested>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </SettingsShell>
    );
  }
  // Another Market's or an unknown id looks the same: not found (ux B5).
  const role = result.body.items.find((item) => item.roleId === roleId);
  if (role === undefined) notFound();
  const keys = gate.session.permissionKeys;
  if (role.kind === 'custom' && role.actions.edit.allowed && keys.includes(EDIT_PERMISSION)) {
    return (
      <SettingsShell session={gate.session} linkId="roles" title={title} nested>
        <RoleEditor
          // A new version remounts the form, so a refresh after a save shows the saved state.
          key={role.version}
          role={role}
          catalogue={result.body}
          csrfToken={gate.session.csrfToken}
          initialName={role.name ?? ''}
          initialKeys={role.permissionKeys}
        />
      </SettingsShell>
    );
  }
  return (
    <SettingsShell session={gate.session} linkId="roles" title={title} nested>
      <RoleView
        role={role}
        catalogue={result.body}
        canDuplicate={keys.includes(CREATE_PERMISSION)}
      />
    </SettingsShell>
  );
}
