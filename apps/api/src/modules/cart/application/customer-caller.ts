import type { CallContext } from '@mondapac/shared-kernel';
import type { CartCaller } from './cart-operations';

/** The signed-in customer's account, from the session; null for any other actor (fail closed). */
export type AccountCaller = Extract<CartCaller, { kind: 'account' }>;

export function customerCaller(context: CallContext): AccountCaller | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'customer'
    ? { kind: 'account', accountId: actor.accountId }
    : null;
}
