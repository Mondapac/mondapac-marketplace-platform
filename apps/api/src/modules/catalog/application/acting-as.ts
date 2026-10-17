import type { ActorContext } from '@mondapac/shared-kernel';

/**
 * Whether the actor is an acting-as (Login as Seller, SEL-08) session (catalog design 8.2 "AA";
 * Hassan L1). The marker is reserved as `actingAs` on the actor (identity design 3.4 row 6, 4):
 * SEL-08 adds it and no session carries it yet. Catalog reads the same reserved field as identity
 * does, from the shared actor type, without importing identity: the first session that carries
 * the marker is refused by every tag write here without a change.
 */
export function isActingAsSession(actor: ActorContext): boolean {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}
