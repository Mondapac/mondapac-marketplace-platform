import type { CallContext, Id } from '@mondapac/shared-kernel';

/** The signed-in customer's account, from the session; null for any other actor (fail closed). */
export function customerAccountId(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'customer' ? actor.accountId : null;
}
