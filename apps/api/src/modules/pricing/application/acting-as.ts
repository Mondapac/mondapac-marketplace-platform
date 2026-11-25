import type { ActorContext } from '@mondapac/shared-kernel';

/**
 * Whether the actor is an acting-as (Login as Seller, SEL-08) session. The marker is reserved as
 * `actingAs` on the actor (identity design 3.4 row 6); pricing reads the same reserved field
 * from the shared actor type, without importing identity, as catalog does. Until the SEL-08
 * mini-review decides whether acting-as may touch prices, Cost reads and writes are refused in
 * such a session (pricing design 5.4; Hassan finding 6): fail closed, so the first session that
 * carries the marker is refused without a change here.
 */
export function isActingAsSession(actor: ActorContext): boolean {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}
