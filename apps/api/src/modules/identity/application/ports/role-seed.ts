import type { RoleScope } from '../../domain/role';

/**
 * One role of the checked-in seed (identity design 5.6): a stable code, a translation key for
 * its name and its keys. System roles hold every key of their scope by definition (R3), so
 * their list is empty; default roles arrive with slice 8a.
 */
export interface SeededRole {
  readonly scope: RoleScope;
  readonly kind: 'system';
  readonly seedCode: string;
  readonly seedVersion: number;
  /** The translation key of the role's name: never stored, never in an event. */
  readonly nameKey: string;
  readonly permissionKeys: readonly string[];
}

/** The seed of every scope, read by the seed routine (5.6). */
export interface RoleSeed {
  roles(): readonly SeededRole[];
}

/** Nest token of the {@link RoleSeed}. */
export const ROLE_SEED = Symbol('ROLE_SEED');
