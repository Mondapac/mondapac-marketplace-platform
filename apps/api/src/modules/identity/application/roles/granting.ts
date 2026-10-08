import type { Id, MarketContext, Population } from '@mondapac/shared-kernel';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import type {
  ActedOnAccount,
  GrantedRole,
  GrantingActor,
  ProtectedKeyCatalogue,
} from '../../domain/grant-policy';
import { scopeOfPopulation, type Role } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { RoleGrantReader } from '../ports/role-grant-reader';

/** An account whose grant is read: who it is, as the actor context or the store says. */
export interface GrantSubject {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  /** The seller of the account's active membership; null outside the seller population. */
  readonly sellerId: Id<'Seller'> | null;
}

/** What `GrantPolicy` reads of the actor and of the accounts it acts on, read in one unit. */
export interface GrantReading {
  readonly actor: GrantingActor;
  readonly targets: ReadonlyMap<Id<'Account'>, ActedOnAccount>;
}

/**
 * The grant read of every use case that applies `GrantPolicy` (identity design 5.4, 5.5; slices
 * 8a-2 and 8b; Hassan I-2 on slice 8a-1). It runs **in the caller's unit**, the one that then
 * writes, so the actor's role id, whether that role is the system role of its scope, and the
 * effective keys of the actor and of each target all come from one read of committed state,
 * never from the gate's earlier read-only unit or from the actor summary. Effective keys come
 * from the one resolver of the process (`EFFECTIVE_KEY_RESOLVER`), so the policy and the gate
 * cannot disagree on what a role confers.
 *
 * The actor's `scope` is its population's (R2); an actor without an assignment holds no key and
 * no role. `ActedOnAccount.scope` is null for a customer, who has no role.
 */
export async function readGrants(
  grants: RoleGrantReader,
  resolve: EffectiveKeyResolver,
  market: MarketContext,
  actor: GrantSubject,
  targets: readonly GrantSubject[],
): Promise<GrantReading | null> {
  const actorScope = scopeOfPopulation(actor.population);
  if (actorScope === null) return null;
  const read = await grants.grantsOf(market, [
    actor.accountId,
    ...targets.map((target) => target.accountId),
  ]);
  const actorGrant = read.get(actor.accountId) ?? null;
  const actorKeys = resolve({ ...actor, grant: actorGrant });
  const actorView: GrantingActor = {
    accountId: actor.accountId,
    scope: actorScope,
    roleId: actorGrant?.roleId ?? null,
    // The system role counts only in the actor's own scope (R2).
    holdsSystemRole: actorGrant?.kind === 'system' && actorGrant.scope === actorScope,
    effectiveKeys: actorKeys,
  };
  const targetViews = new Map<Id<'Account'>, ActedOnAccount>();
  for (const target of targets) {
    targetViews.set(target.accountId, {
      accountId: target.accountId,
      scope: scopeOfPopulation(target.population),
      effectiveKeys: resolve({ ...target, grant: read.get(target.accountId) ?? null }),
    });
  }
  return { actor: actorView, targets: targetViews };
}

/**
 * The role as `GrantPolicy.canGrant` sees it: what it would confer (identity design 5.5). Its
 * keys are resolved as for a holder of the role who belongs to the role's own seller, so a
 * system role means every key of its scope and a default or custom role its stored keys that
 * the registry still declares (R3, R7).
 */
export function grantedRoleOf(role: Role, resolve: EffectiveKeyResolver): GrantedRole {
  const { id, scope, kind, sellerId, permissionKeys } = role.state;
  const effectiveKeys = resolve({
    population: scope === 'platform' ? 'admin' : 'seller',
    accountId: id as unknown as Id<'Account'>,
    sellerId,
    grant: { roleId: id, kind, scope, sellerId, storedKeys: permissionKeys },
  });
  return { id, scope, kind, effectiveKeys };
}

/**
 * Hassan I-2 on slice 8a-1: before `canGrant`, a caller checks that a seller's custom role
 * belongs to the actor's own seller (R9). An admin actor has no seller, so no seller's role is
 * ever its to grant; a platform role has no seller. Answers whether the role may be considered
 * at all; a role that fails is answered as unknown, byte-identical to a missing one (5.2).
 */
export function roleIsInActorsReach(role: Role, actor: GrantSubject): boolean {
  if (role.state.scope !== scopeOfPopulation(actor.population)) return false;
  return role.state.sellerId === null || role.state.sellerId === actor.sellerId;
}

/** Which keys are protected (R11), from the sealed permission registry. */
export function protectedKeysOf(
  registry: Pick<SealedPermissionCatalogue, 'get'>,
): ProtectedKeyCatalogue {
  return { isProtected: (key) => registry.get(key)?.protected === true };
}
