import { Badge, type BadgeTone } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { roleName } from './role-name.ts';
import type { RoleRecord } from './types.ts';

const KINDS = ['system', 'default', 'custom'] as const;
const TONE: Record<RoleRecord['kind'], BadgeTone> = {
  system: 'neutral',
  default: 'neutral',
  custom: 'neutral',
};

/** B2: roles grouped System, Default, Custom with their permission counts (read only). */
export async function RolesTable({
  roles,
  members = null,
}: {
  readonly roles: readonly RoleRecord[];
  /** Active accounts per role id; null leaves the Members column out. */
  readonly members?: ReadonlyMap<string, number> | null;
}) {
  const t = await getTranslations();
  return (
    <div className="flex flex-col gap-6">
      {KINDS.map((kind) => {
        const rows = roles.filter((role) => role.kind === kind);
        if (rows.length === 0 && kind !== 'custom') return null;
        return (
          <section key={kind} aria-labelledby={`roles-${kind}`}>
            <h2 id={`roles-${kind}`} className="mb-2 text-lg font-semibold">
              {t(`identity.roles.group.${kind}`)}
            </h2>
            {rows.length === 0 ? (
              <div className="rounded-lg border border-line p-6">
                <p className="font-medium">{t('identity.roles.empty-custom.title')}</p>
                <p className="mt-1 text-fg-muted">{t('identity.roles.empty-custom.body')}</p>
              </div>
            ) : (
              <div className="relative overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-160 text-start text-sm">
                  <caption className="sr-only">{t(`identity.roles.group.${kind}`)}</caption>
                  <thead className="bg-muted text-fg-muted">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {t('identity.roles.label.role')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {t('identity.roles.label.type')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {t('identity.roles.label.permissions')}
                      </th>
                      {members === null ? null : (
                        <th scope="col" className="px-4 py-3 font-medium">
                          {t('identity.roles.label.members')}
                        </th>
                      )}
                      <th scope="col" className="px-4 py-3 text-end font-medium">
                        {t('identity.members.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-row">
                    {rows.map((role) => {
                      const name = roleName(t, role);
                      return (
                        <tr key={role.roleId}>
                          <td className="break-words px-4 py-3 font-medium text-fg">{name}</td>
                          <td className="px-4 py-3">
                            <Badge tone={TONE[role.kind]}>
                              {role.kind === 'system' ? (
                                <span className="me-1" aria-hidden="true">
                                  🔒
                                </span>
                              ) : null}
                              {t(`identity.roles.type.${role.kind}`)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {role.kind === 'system'
                              ? t('identity.roles.permissions-all')
                              : role.permissionCount === 0
                                ? t('identity.roles.permissions-none')
                                : t('identity.members.role.permission-count', {
                                    count: role.permissionCount,
                                  })}
                          </td>
                          {members === null ? null : (
                            <td className="px-4 py-3">
                              {t('identity.roles.members-count', {
                                count: members.get(role.roleId) ?? 0,
                              })}
                            </td>
                          )}
                          <td className="px-4 py-3 text-end">
                            <a
                              className="font-medium text-link underline"
                              href={`/roles/${role.roleId}`}
                            >
                              {t(
                                role.kind === 'custom' && role.actions.edit.allowed
                                  ? 'identity.roles.action.edit'
                                  : 'identity.roles.action.view',
                              )}{' '}
                              <span className="sr-only">{name}</span>
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
