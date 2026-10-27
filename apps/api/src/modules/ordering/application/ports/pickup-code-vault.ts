import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';

/** The buyer's account key was destroyed (the account was erased): no code can be made or read. */
export type PickupKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/** A freshly issued code: shown to the buyer, stored as a hash and as a copy sealed for them. */
export interface IssuedPickupCode {
  /** The plain code. Returned once, to the caller that stores it; never logged or put in an event. */
  readonly code: string;
  readonly hash: string;
  readonly sealed: string;
}

/**
 * Makes, hashes and seals pickup codes under the buyer's subject key. The code comes from a
 * CSPRNG. The hash is a keyed hash (HMAC under a key derived from the buyer's data key and bound
 * to the seller order), so a copy of the database cannot be searched for the 10,000 possible
 * codes. The sealed copy is what lets the buyer read the code again. Plaintext never reaches a
 * log, an event or an error.
 */
export interface PickupCodeVault {
  issue(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<Result<IssuedPickupCode, PickupKeyDestroyed>>;

  /** The keyed hash of a code typed by the seller, to compare with the stored hash. */
  digest(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerOrderId: Id<'SellerOrder'>,
    code: string,
  ): Promise<Result<string, PickupKeyDestroyed>>;

  /** Opens the sealed copy for the buyer. */
  reveal(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerOrderId: Id<'SellerOrder'>,
    sealed: string,
  ): Promise<Result<string, PickupKeyDestroyed>>;
}

export const PICKUP_CODE_VAULT = Symbol('PICKUP_CODE_VAULT');
