import type { Id, Population } from '@mondapac/shared-kernel';

/** The two scopes of a permission (R2): there is no customer scope. */
export type PermissionScopeOfRole = 'platform' | 'seller';

/**
 * The role an account holds, as the key rule needs it (identity design 2.1, 5.5): a system role
 * stores no keys and means every key of its scope; a custom role holds its stored keys.
 */
export interface RoleGrant {
  readonly kind: 'system' | 'custom';
  readonly scope: PermissionScopeOfRole;
  readonly storedKeys: readonly string[];
}

/**
 * What the permission registry tells the key rule (identity design 5.3; slice 8a-1): the keys
 * declared in a scope. A stored key the registry does not know is never held (R7).
 */
export interface PermissionRegistryView {
  keysOf(scope: PermissionScopeOfRole): ReadonlySet<string>;
}

/**
 * Whose effective permission keys are asked for (identity design 5.2, 5.5). `grant` is the
 * account's role; slice 8a-1 reads it from the role assignment. Absent, the account holds none.
 */
export interface EffectiveKeysSubject {
  readonly population: Population;
  readonly accountId: Id<'Account'>;
  readonly grant?: RoleGrant | null;
}

/**
 * The effective-key resolver as a port: the gate and the reviewer rule take one, and in
 * production both get {@link effectiveKeysOf} with the registry of the time. Tests pass
 * `effectiveKeysOf` with fixture grants and a fixture registry: never a second rule.
 */
export type EffectiveKeyResolver = (subject: EffectiveKeysSubject) => ReadonlySet<string>;

const NO_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** The registry until slice 8a-1: it knows no key, so no account holds one. */
export const EMPTY_PERMISSION_REGISTRY: PermissionRegistryView = Object.freeze({
  keysOf: () => NO_KEYS,
});

const SCOPE_OF: Readonly<Record<Population, PermissionScopeOfRole | null>> = Object.freeze({
  customer: null,
  seller: 'seller',
  admin: 'platform',
});

/**
 * The one definition of "which permission keys does this account hold" (identity design 5.2,
 * 8.7; Hassan M2, Ali C5). `AccountAuthorisationCheck` decides every `permissions` rule with it,
 * and the reviewer-notice recipients are evaluated with it, so the two can never disagree.
 *
 * A customer never holds a key (R2). A role of another scope than the population's holds none. A
 * system role holds every key the registry declares in its scope; a custom role holds the stored
 * keys the registry still declares in its scope (R7). Until slice 8a-1 no grant is read and the
 * registry is {@link EMPTY_PERMISSION_REGISTRY}, so the answer is empty for every account, as the
 * gate has denied every `permissions` rule since slice 2.
 */
export function effectiveKeysOf(
  subject: EffectiveKeysSubject,
  registry: PermissionRegistryView = EMPTY_PERMISSION_REGISTRY,
): ReadonlySet<string> {
  const scope = SCOPE_OF[subject.population];
  const grant = subject.grant ?? null;
  if (scope === null || grant === null || grant.scope !== scope) return NO_KEYS;
  const declared = registry.keysOf(scope);
  if (grant.kind === 'system') return declared;
  return new Set(grant.storedKeys.filter((key) => declared.has(key)));
}

/**
 * Whether `held` contains every key of `required` (an `allOf` rule; never "any of"). An empty
 * requirement is never satisfied: a rule that names no key grants nothing (Hassan I-2).
 */
export function holdsEvery(held: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.length > 0 && required.every((key) => held.has(key));
}
