import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { RoleKind, RoleScope } from './role';

/**
 * The actor of a grant or of an action on another account (identity design 5.5): its scope,
 * its one role, whether that role is the system role of its scope, and its effective keys
 * (`effectiveKeysOf`, read by the caller in the same unit).
 */
export interface GrantingActor {
  readonly accountId: Id<'Account'>;
  readonly scope: RoleScope;
  readonly roleId: Id<'Role'> | null;
  readonly holdsSystemRole: boolean;
  readonly effectiveKeys: ReadonlySet<string>;
}

/** A role being put in a role, assigned or invited with: what it would confer. */
export interface GrantedRole {
  readonly id: Id<'Role'>;
  readonly scope: RoleScope;
  readonly kind: RoleKind;
  /** Every key the role confers: for a system role, every key of its scope (R3). */
  readonly effectiveKeys: ReadonlySet<string>;
}

/** The account an actor acts on (assign, remove, disable, reset a second factor). */
export interface ActedOnAccount {
  readonly accountId: Id<'Account'>;
  /** The scope of its population; null for a customer, who has no role (R2). */
  readonly scope: RoleScope | null;
  readonly effectiveKeys: ReadonlySet<string>;
}

/** Which keys are protected (R11): the permission registry, read by the caller. */
export interface ProtectedKeyCatalogue {
  isProtected(key: string): boolean;
}

/** Why a grant is refused: the log reason; the answer is always `role.not-grantable` (8.6). */
export type NotGrantableReason =
  | 'scope'
  | 'keys-not-held'
  | 'protected-key'
  | 'system-role'
  | 'seller-protected-key'
  | 'seller-system-role';

export type NotGrantable = {
  readonly code: 'role.not-grantable';
  readonly reason: NotGrantableReason;
};
export type CannotActOn =
  { readonly code: 'member.self' } | { readonly code: 'member.outranks-actor' };

/**
 * Phase 2 narrowing of R11 in seller scope (identity brief s3, AC 35 last clause; design 5.4):
 * protected seller keys are not grantable at all, and the seller system role is founded, never
 * granted (HF5 c), so only the Seller Owner manages the team. A later mini-review lifts it.
 */
const SELLER_SCOPE_GRANTS_PROTECTED_OR_SYSTEM = false;

const notGrantable = (reason: NotGrantableReason): Result<never, NotGrantable> =>
  err({ code: 'role.not-grantable', reason });

const isSubset = (inner: ReadonlySet<string>, outer: ReadonlySet<string>): boolean => {
  for (const key of inner) if (!outer.has(key)) return false;
  return true;
};

/**
 * `GrantPolicy` (identity design 5.5): a pure domain service. Every use case that creates or
 * edits a role, assigns one, or issues or accepts an invitation calls {@link canGrant}; assign,
 * remove, disable and reset-second-factor call {@link canActOn} (5.4 row R1). The founding
 * assignment of a new scope is not a grant and does not come here (5.5, Ali 14.1-2).
 */
export const GrantPolicy = Object.freeze({
  /**
   * Whether `actor` may put `role` in place: never across scopes (R2); every key the role
   * confers is one the actor holds (R1); a protected key needs the system role of the scope
   * (R11); a system role needs the actor to hold that same role (R3, AC 34); in seller scope,
   * in Phase 2, no protected key and never the system role.
   */
  canGrant(
    actor: GrantingActor,
    role: GrantedRole,
    catalogue: ProtectedKeyCatalogue,
  ): Result<void, NotGrantable> {
    if (role.scope !== actor.scope) return notGrantable('scope');
    const protectedKey = [...role.effectiveKeys].some((key) => catalogue.isProtected(key));
    if (role.scope === 'seller' && !SELLER_SCOPE_GRANTS_PROTECTED_OR_SYSTEM) {
      if (role.kind === 'system') return notGrantable('seller-system-role');
      if (protectedKey) return notGrantable('seller-protected-key');
    }
    if (!isSubset(role.effectiveKeys, actor.effectiveKeys)) return notGrantable('keys-not-held');
    if (role.kind === 'system' && !(actor.holdsSystemRole && actor.roleId === role.id)) {
      return notGrantable('system-role');
    }
    if (protectedKey && !actor.holdsSystemRole) return notGrantable('protected-key');
    return ok(undefined);
  },

  /**
   * Whether `actor` may act on `target`: never on itself; within one scope only when the
   * target's keys are a subset of the actor's (R1). Across scopes the subset test means
   * nothing, because scopes share no keys (R2): an admin is then decided by its platform
   * permission alone, checked by the gate (Ali 14.1-2); a seller-side actor never acts outside
   * its scope.
   */
  canActOn(actor: GrantingActor, target: ActedOnAccount): Result<void, CannotActOn> {
    if (target.accountId === actor.accountId) return err({ code: 'member.self' });
    if (target.scope !== actor.scope) {
      return actor.scope === 'platform' ? ok(undefined) : err({ code: 'member.outranks-actor' });
    }
    return isSubset(target.effectiveKeys, actor.effectiveKeys)
      ? ok(undefined)
      : err({ code: 'member.outranks-actor' });
  },
});
