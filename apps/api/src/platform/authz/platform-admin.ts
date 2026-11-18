import type { ActorContext } from '@mondapac/shared-kernel';

/**
 * A platform admin (security review of #969, I3): an authenticated actor of the admin population,
 * not a seller's member and not in an acting-as session (the reserved `actingAs` marker on the
 * actor, identity design 3.4 row 6). The population check of the admin reads that are not a
 * permission alone; the keys are still the gate's. Anything else, the system actor included, is
 * not one (fail closed).
 */
export function isPlatformAdminActor(actor: ActorContext): boolean {
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || actor.sellerId !== null) {
    return false;
  }
  if (!Object.hasOwn(actor, 'actingAs')) return true;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker === null || marker === undefined;
}
