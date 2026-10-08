import type { RoleSeed, SeededRole } from '../../application/ports/role-seed';
import { PLATFORM_ROLES_SEED } from './platform-roles.seed';
import { SELLER_ROLES_SEED } from './seller-roles.seed';

/** A seed that breaks a rule of 5.6: refused at boot and by the unit test. */
export class RoleSeedError extends Error {
  override readonly name = 'RoleSeedError';
}

const SEED_CODE = /^[a-z][a-z0-9-]*$/;

/**
 * Checks the seed files of `seed/` (identity design 5.6, R3): every code a lower-case code,
 * unique per scope, a positive integer version, and exactly one system role per scope with no
 * stored keys (it holds every key of its scope by definition). The key checks against the
 * registry (unknown, wrong scope, protected) join with the default roles and the registry in
 * slice 8a, when a seeded role first lists keys.
 */
export function checkRoleSeed(roles: readonly SeededRole[]): readonly SeededRole[] {
  const codes = new Set<string>();
  const systemScopes = new Set<string>();
  for (const role of roles) {
    if (!SEED_CODE.test(role.seedCode) || role.seedCode.length > 64) {
      throw new RoleSeedError(`Seed code "${role.seedCode}" is not a lower-case code`);
    }
    if (!Number.isInteger(role.seedVersion) || role.seedVersion < 1) {
      throw new RoleSeedError(`Seed "${role.seedCode}" needs a positive integer version`);
    }
    const key = `${role.scope}:${role.seedCode}`;
    if (codes.has(key)) throw new RoleSeedError(`Seed "${key}" appears twice`);
    codes.add(key);
    if (role.kind === 'system') {
      if (role.permissionKeys.length > 0) {
        throw new RoleSeedError(`System role "${key}" stores no keys (R3)`);
      }
      if (systemScopes.has(role.scope)) {
        throw new RoleSeedError(`Scope "${role.scope}" has two system roles`);
      }
      systemScopes.add(role.scope);
    }
  }
  for (const scope of ['platform', 'seller']) {
    if (!systemScopes.has(scope)) throw new RoleSeedError(`Scope "${scope}" has no system role`);
  }
  return Object.freeze([...roles]);
}

/** The {@link RoleSeed} of the checked-in files, checked when it is built (at boot). */
export class CheckedInRoleSeed implements RoleSeed {
  readonly #roles = checkRoleSeed([...PLATFORM_ROLES_SEED, ...SELLER_ROLES_SEED]);

  roles(): readonly SeededRole[] {
    return this.#roles;
  }
}
