import type { Id, Population } from '@mondapac/shared-kernel';
import { frozenKeySet, type SealedPermissionCatalogue } from '../../../../platform/authz';

/** The two scopes of a permission (R2): there is no customer scope. */
export type PermissionScopeOfRole = 'platform' | 'seller';

/**
 * The role an account holds, as the key rule needs it (identity design 2.1, 5.5): a system role
 * stores no keys and means every key of its scope; a default or custom role holds its stored
 * keys. `sellerId` is set only on a seller's custom role (R9).
 */
export interface RoleGrant {
  readonly roleId: Id<'Role'>;
  readonly kind: 'system' | 'default' | 'custom';
  readonly scope: PermissionScopeOfRole;
  readonly sellerId: Id<'Seller'> | null;
  readonly storedKeys: readonly string[];
}

/**
 * What the permission registry tells the key rule (identity design 5.3): the keys declared in a
 * scope. A stored key the registry does not know is never held (R7).
 */
export interface PermissionRegistryView {
  keysOf(scope: PermissionScopeOfRole): ReadonlySet<string>;
}

/**
 * Whose effective permission keys are asked for (identity design 5.2, 5.5). `grant` is the
 * account's role, read from its assignment by the caller in its own read-only unit
 * ({@link RoleGrantReader}); absent, the account holds none. `sellerId` is the seller the actor
 * works for (from `ActorContext`, R6): a seller's custom role grants nothing to an account of
 * another seller.
 */
export interface EffectiveKeysSubject {
  readonly population: Population;
  readonly accountId: Id<'Account'>;
  readonly sellerId?: Id<'Seller'> | null;
  readonly grant?: RoleGrant | null;
}

/**
 * The effective-key resolver as a port: the gate (`AccountAuthorisationCheck`) and the reviewer
 * rule take one, through the one Nest token {@link EFFECTIVE_KEY_RESOLVER} (R-3 review N-1), and
 * in production both get {@link effectiveKeysOf} bound to the permission registry. Tests pass
 * `effectiveKeysOf` with a fixture registry: never a second rule.
 */
export type EffectiveKeyResolver = (subject: EffectiveKeysSubject) => ReadonlySet<string>;

/**
 * Nest token of the one {@link EffectiveKeyResolver} of the process (R-3 review N-1): injected
 * by the `AuthorisationCheck` and by the reviewer read, so the gate and the reviewer rule cannot
 * be bound to two different resolvers.
 */
export const EFFECTIVE_KEY_RESOLVER = Symbol('EFFECTIVE_KEY_RESOLVER');

const NO_KEYS: ReadonlySet<string> = frozenKeySet();

/** A registry that knows no key: for tests that need one; production binds the real one. */
export const EMPTY_PERMISSION_REGISTRY: PermissionRegistryView = Object.freeze({
  keysOf: () => NO_KEYS,
});

/** The registry as the key rule reads it: the frozen key set of each scope (N-2). */
export function registryView(
  registry: Pick<SealedPermissionCatalogue, 'keysOf'>,
): PermissionRegistryView {
  return Object.freeze({ keysOf: (scope: PermissionScopeOfRole) => registry.keysOf(scope) });
}

const SCOPE_OF: Readonly<Record<Population, PermissionScopeOfRole | null>> = Object.freeze({
  customer: null,
  seller: 'seller',
  admin: 'platform',
});

/**
 * The one definition of "which permission keys does this account hold" (identity design 5.2,
 * 5.5, 8.7; Hassan M2, Ali C5). `AccountAuthorisationCheck` decides every `permissions` rule
 * with it, the reviewer-notice recipients are evaluated with it, and the actor summary reports
 * it, so they can never disagree.
 *
 * A customer never holds a key (R2). A role of another scope than the population's holds none,
 * and so does a seller's custom role for an account of another seller (R9). A system role
 * holds every key the registry declares in its scope; a default or custom role holds the stored
 * keys the registry still declares in its scope (R7). The answer is always a frozen set (N-2).
 */
export function effectiveKeysOf(
  subject: EffectiveKeysSubject,
  registry: PermissionRegistryView,
): ReadonlySet<string> {
  const scope = SCOPE_OF[subject.population];
  const grant = subject.grant ?? null;
  if (scope === null || grant === null || grant.scope !== scope) return NO_KEYS;
  if (grant.sellerId !== null && grant.sellerId !== (subject.sellerId ?? null)) return NO_KEYS;
  const declared = registry.keysOf(scope);
  if (grant.kind === 'system') return declared;
  return frozenKeySet(grant.storedKeys.filter((key) => declared.has(key)));
}

/**
 * Whether `held` contains every key of `required` (an `allOf` rule; never "any of"). An empty
 * requirement is never satisfied: a rule that names no key grants nothing (Hassan I-2).
 */
export function holdsEvery(held: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.length > 0 && required.every((key) => held.has(key));
}
