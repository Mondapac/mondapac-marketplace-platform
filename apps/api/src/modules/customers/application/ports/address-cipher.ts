import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AddressContent } from '../../domain/address';

/** The account's key was destroyed (the account was erased): its addresses are gone for good. */
export type AccountKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/**
 * Seals and opens an address under the customer account's subject key (created by `identity`
 * with the account). Plaintext never leaves the module, a log or an error.
 */
export interface AddressCipher {
  seal(
    market: MarketContext,
    accountId: Id<'Account'>,
    content: AddressContent,
  ): Promise<Result<string, AccountKeyDestroyed>>;
  open(
    market: MarketContext,
    accountId: Id<'Account'>,
    sealed: string,
  ): Promise<Result<AddressContent, AccountKeyDestroyed>>;
}

export const ADDRESS_CIPHER = Symbol('ADDRESS_CIPHER');
