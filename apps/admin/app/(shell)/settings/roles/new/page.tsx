import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RoleEditor } from '../../../../../src/roles/role-editor.tsx';
import { RolesNoAccess } from '../../../../../src/roles/roles-page-gate.tsx';
import type { RoleCatalogue } from '../../../../../src/roles/types.ts';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { SettingsShell } from '../../../../../src/server/settings-shell.tsx';

const VIEW_PERMISSION = 'identity.platform-role.view';
const CREATE_PERMISSION = 'identity.platform-role.create';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.members.title.admin') };
}

/** B4: a new custom role, optionally starting from a copy of another role (`?from=<roleId>`). */
export default async function NewRolePageRoute({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly from?: string | string[] }>;
}) {
  const { from } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const keys = gate.session.permissionKeys;
  if (!keys.includes(VIEW_PERMISSION) || !keys.includes(CREATE_PERMISSION)) {
    return <RolesNoAccess session={gate.session} />;
  }
  const result = await serverGet<RoleCatalogue>('identity/admin/roles');
  if (result.kind === 'signed-out') redirect('/session-ended');
  const title = t('identity.members.title.admin');
  if (result.kind !== 'ok') {
    return (
      <SettingsShell session={gate.session} linkId="roles" title={title} nested>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <LoadError
          title={t('settings.load-error.title', { page: title })}
          message={t('settings.load-error.body')}
          retryLabel={t('load.retry')}
          className="w-full"
        />
      </SettingsShell>
    );
  }
  const source =
    typeof from === 'string' ? result.body.items.find((item) => item.roleId === from) : undefined;
  // Only keys this admin may give are carried over, so the copy can be saved as it stands.
  const grantable = new Set(result.body.keys.filter((k) => k.grantable).map((k) => k.key));
  const initialKeys =
    source === undefined || source.kind === 'system'
      ? []
      : source.permissionKeys.filter((key) => grantable.has(key));
  return (
    <SettingsShell session={gate.session} linkId="roles" title={title} nested>
      <RoleEditor
        catalogue={result.body}
        csrfToken={gate.session.csrfToken}
        initialName=""
        initialKeys={initialKeys}
      />
    </SettingsShell>
  );
}
