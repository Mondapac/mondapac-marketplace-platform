import type { CallContext, Id } from '@mondapac/shared-kernel';

/** Whether the actor is an acting-as session (Login as Seller): the reserved marker on the actor. */
export function isActingAs(context: CallContext): boolean {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

/**
 * An admin session that is not acting as someone else. Every promotions write refuses an acting-as
 * session: the platform's money and a seller's are never moved on someone else's behalf.
 */
export function adminAccountId(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  if (isActingAs(context)) return null;
  return actor.accountId;
}

export interface SellerCaller {
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'>;
}

/** A seller session that is not an acting-as session; null for anyone else (fail closed). */
export function sellerCaller(context: CallContext): SellerCaller | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller' || actor.sellerId === null) {
    return null;
  }
  if (isActingAs(context)) return null;
  return { accountId: actor.accountId, sellerId: actor.sellerId };
}
