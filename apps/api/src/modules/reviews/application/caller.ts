import type { CallContext, Id } from '@mondapac/shared-kernel';

/** Whether the actor is an acting-as session (Login as Seller): the reserved marker on the actor. */
export function isActingAs(context: CallContext): boolean {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

/**
 * The signed-in buyer's account, from the session; null for anyone else and for an acting-as
 * session (support may look at a shop, never write a review as a buyer): fail closed.
 */
export function buyerAccountId(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'customer') return null;
  if (isActingAs(context)) return null;
  return actor.accountId;
}

/** An admin session that is not acting as someone else. */
export function adminAccountId(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  if (isActingAs(context)) return null;
  return actor.accountId;
}
