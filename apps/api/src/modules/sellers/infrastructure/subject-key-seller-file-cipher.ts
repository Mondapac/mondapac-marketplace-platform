import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type {
  SealedFieldValues,
  SellerFileCipher,
  SellerKeyDestroyed,
} from '../application/ports/seller-file-cipher';
import { addressToJson, type Address } from '../domain/address';
import type { Sealed, SealedField } from '../domain/sealed';
import { SELLER_FILE_LABELS } from './seller-file-labels';

/** The clear text that is sealed: an address as its canonical JSON, any other field as is. */
function plainOf<F extends SealedField>(field: F, value: SealedFieldValues[F]): string {
  return field === 'address' || field === 'registered-address'
    ? addressToJson(value as Address)
    : (value as string);
}

/**
 * {@link SellerFileCipher} on the platform `SubjectKeyService` (sellers design 8.1; PF 4): the
 * subject is the seller id, whose key `identity` created with the seller; `sellers` never calls
 * `createKey` (a missing key throws `SubjectKeyMissingError`, a programming error). The v1
 * envelope and its binding to Market, subject and label are the platform's.
 */
export class SubjectKeySellerFileCipher implements SellerFileCipher {
  constructor(private readonly keys: SubjectKeyService) {}

  async seal<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    value: SealedFieldValues[F],
  ): Promise<Result<Sealed<F>, SellerKeyDestroyed>> {
    const sealed = await this.keys.encrypt(
      market,
      sellerId,
      SELLER_FILE_LABELS[field],
      plainOf(field, value),
    );
    return sealed as Result<Sealed<F>, SellerKeyDestroyed>;
  }

  open<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    sealed: Sealed<F>,
  ): Promise<Result<string, SellerKeyDestroyed>> {
    return this.keys.decrypt(market, sellerId, SELLER_FILE_LABELS[field], sealed);
  }
}
