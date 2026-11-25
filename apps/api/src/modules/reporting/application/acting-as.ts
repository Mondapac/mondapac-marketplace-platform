import type { ActorContext } from '@mondapac/shared-kernel';

/**
 * Whether the actor is an acting-as (Login as Seller, SEL-08) session. The marker is reserved as
 * `actingAs` on the shared actor type (identity design 3.4 row 6, 4), read here as catalog,
 * ordering and tax read it, without importing identity.
 */
export function isActingAsSession(actor: ActorContext): boolean {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}
