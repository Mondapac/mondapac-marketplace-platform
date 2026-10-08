import { PERMISSION_KEY_PATTERN, type PermissionKey } from './access-rule';

/**
 * The longest permission key a module may declare (slice 8a-1; Mohammad 3, Hassan L-1). It
 * bounds the audit rows that list keys: one `identity.role.seed-applied` row holds up to 40 keys
 * added and 40 removed, and must stay under the audit writer's 4 KB per side
 * (`MAX_AUDIT_SIDE_BYTES`); a test proves the worst case fits. The longest key today is 43
 * characters (`identity.seller-account.reset-second-factor`).
 */
export const MAX_PERMISSION_KEY_LENGTH = 45;

/** True for a well-formed key no longer than {@link MAX_PERMISSION_KEY_LENGTH}. */
export function isDeclarablePermissionKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length <= MAX_PERMISSION_KEY_LENGTH &&
    PERMISSION_KEY_PATTERN.test(key)
  );
}

/** The two scopes of a permission (R2): there is no customer scope. */
export const PERMISSION_SCOPES = ['platform', 'seller'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * One permission (platform-foundations design 6.1). Declared as a constant in the owning
 * module's `contracts/` through {@link definePermission}; use cases name the constant's `key`.
 * No Market, no vertical and no display text: labels are translation keys derived from the key.
 */
export interface PermissionDeclaration {
  readonly key: PermissionKey;
  readonly scope: PermissionScope;
  /** R11; always written out, there is no default. */
  readonly protected: boolean;
}

/** Every permission one module declares, as the CI check and (slice 8a) the registry read it. */
export interface PermissionCatalogue {
  readonly module: string;
  readonly declarations: readonly PermissionDeclaration[];
}

/** A malformed declaration: a programmer error, refused when the module is loaded. */
export class PermissionDeclarationError extends Error {
  override readonly name = 'PermissionDeclarationError';
}

const catalogues = new WeakSet<object>();

/**
 * The one helper that validates and brands a key (foundations 6.1): three lower-case segments,
 * the first the declaring module; a scope of the closed list; `protected` written out.
 */
export function definePermission(
  module: string,
  declaration: {
    readonly key: string;
    readonly scope: PermissionScope;
    readonly protected: boolean;
  },
): PermissionDeclaration {
  const { key, scope } = declaration;
  if (!isDeclarablePermissionKey(key)) {
    throw new PermissionDeclarationError(
      `Malformed or overlong permission key "${String(key)}" (at most ${MAX_PERMISSION_KEY_LENGTH} characters)`,
    );
  }
  if (key.split('.')[0] !== module) {
    throw new PermissionDeclarationError(`Module "${module}" cannot declare "${key}"`);
  }
  if (!(PERMISSION_SCOPES as readonly unknown[]).includes(scope)) {
    throw new PermissionDeclarationError(`Permission "${key}" has no valid scope`);
  }
  if (typeof declaration.protected !== 'boolean') {
    throw new PermissionDeclarationError(`Permission "${key}" must state protected`);
  }
  return Object.freeze({ key: key as PermissionKey, scope, protected: declaration.protected });
}

/**
 * A module's catalogue, exported from its `contracts/` (foundations 6.1). Refuses a duplicate
 * key and a declaration of another module. The value is recognised by
 * {@link isPermissionCatalogue}, which is how the CI check finds every declared key.
 */
export function declarePermissions(
  module: string,
  declarations: readonly PermissionDeclaration[],
): PermissionCatalogue {
  const keys = new Set<string>();
  for (const declaration of declarations) {
    const checked = definePermission(module, declaration);
    if (keys.has(checked.key)) {
      throw new PermissionDeclarationError(`Permission "${checked.key}" is declared twice`);
    }
    keys.add(checked.key);
  }
  const catalogue = Object.freeze({ module, declarations: Object.freeze([...declarations]) });
  catalogues.add(catalogue);
  return catalogue;
}

/** True only for a value {@link declarePermissions} returned. */
export function isPermissionCatalogue(value: unknown): value is PermissionCatalogue {
  return typeof value === 'object' && value !== null && catalogues.has(value);
}
