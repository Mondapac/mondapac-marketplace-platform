import type { SellerRole, TeamRole } from './types.ts';

/** The part of a translator the role label needs; server and client translators both fit. */
export interface RoleTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/**
 * A role's label: a custom role by its name (known from the role list when the actor may read
 * it), a seeded role by its seed code, a seed code without a copy key "Role", never the raw code.
 */
export function roleLabel(
  t: RoleTranslator,
  role: TeamRole | null,
  roles: readonly SellerRole[] = [],
): string {
  if (role === null) return t('identity.team.role.none');
  const named = roles.find((entry) => entry.roleId === role.roleId)?.name ?? null;
  if (named !== null) return named;
  const key = `identity.role.${role.seedCode ?? ''}`;
  if (role.seedCode !== null && t.has(key)) return t(key);
  return role.kind === 'custom' ? t('identity.team.role.custom') : t('identity.team.role.unknown');
}

/** The options of the role pickers: the roles the actor may give, nothing else. */
export function grantableOptions(
  t: RoleTranslator & ((key: string, values: Record<string, string | number>) => string),
  roles: readonly SellerRole[],
): { readonly value: string; readonly label: string }[] {
  return roles
    .filter((role) => role.grantable)
    .map((role) => ({
      value: role.roleId,
      label: `${roleLabel(t, role, roles)} · ${t('identity.team.role.permission-count', { count: role.permissionCount })}`,
    }));
}
