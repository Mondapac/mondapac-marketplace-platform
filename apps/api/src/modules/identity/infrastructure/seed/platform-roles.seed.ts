import type { SeededRole } from '../../application/ports/role-seed';

/**
 * The platform scope's roles (identity design 5.6), version 1. Slice 5 seeds the system role,
 * the Platform Administrator, so the first admin of a Market (7.4, slice 7) has a role to
 * receive. The default admin roles join with slice 8a. A change of a role here raises its
 * version.
 */
export const PLATFORM_ROLES_SEED: readonly SeededRole[] = [
  {
    scope: 'platform',
    kind: 'system',
    seedCode: 'platform-administrator',
    seedVersion: 1,
    nameKey: 'identity.role.platform-administrator',
    permissionKeys: [],
  },
];
