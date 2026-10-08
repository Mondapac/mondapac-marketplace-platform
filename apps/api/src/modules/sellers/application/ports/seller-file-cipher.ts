import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { Address } from '../../domain/address';
import type { BusinessName, ContactEmail, Phone } from '../../domain/draft-fields';
import type { Sealed, SealedField } from '../../domain/sealed';

/** What each sealed field holds in clear: only a value its domain parser accepted. */
export interface SealedFieldValues {
  readonly 'business-name': BusinessName;
  readonly phone: Phone;
  readonly 'contact-email': ContactEmail;
  readonly address: Address;
  readonly 'registered-address': Address;
}

/** The seller's key was destroyed (erasure, PF 4 row 6): the values are gone for good. */
export type SellerKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/**
 * Field encryption of the draft (sellers design 8.1; data design 4.1, 4.2): each field under the
 * seller's subject key, which `identity` created with the seller (never here), and the field's
 * own label, so a value copied to another column or another seller's row does not decrypt.
 *
 * Every call reads and unwraps the key once (PF 4 row 9). Called outside the use case's
 * read-write unit (P 3.1 row 5): seal before the unit, open after the read. A failed integrity
 * check or a missing key throws; it is never reported as "not entered".
 */
export interface SellerFileCipher {
  seal<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    value: SealedFieldValues[F],
  ): Promise<Result<Sealed<F>, SellerKeyDestroyed>>;

  /** The clear text of a sealed field; for an address, its canonical JSON. */
  open<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    sealed: Sealed<F>,
  ): Promise<Result<string, SellerKeyDestroyed>>;
}

export const SELLER_FILE_CIPHER = Symbol('SELLER_FILE_CIPHER');
