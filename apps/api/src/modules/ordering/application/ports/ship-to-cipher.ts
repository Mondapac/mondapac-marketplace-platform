import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { ShipTo } from '../../domain/order';

/** The account's key was destroyed (the account was erased): the order's address is gone. */
export type ShipToKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/**
 * Seals and opens an order's {@link ShipTo} under the customer account's subject key (created by
 * `identity` with the account). Plaintext never reaches a log, an event or an error.
 */
export interface ShipToCipher {
  seal(
    market: MarketContext,
    accountId: Id<'Account'>,
    shipTo: ShipTo,
  ): Promise<Result<string, ShipToKeyDestroyed>>;
  open(
    market: MarketContext,
    accountId: Id<'Account'>,
    sealed: string,
  ): Promise<Result<ShipTo, ShipToKeyDestroyed>>;
}

export const SHIP_TO_CIPHER = Symbol('SHIP_TO_CIPHER');
