import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { AddressCipher } from '../application/ports/address-cipher';
import { addressFromJson, addressToJson, type AddressContent } from '../domain/address';
import { ADDRESS_CONTENT_LABEL } from './address-labels';

/**
 * {@link AddressCipher} on the platform `SubjectKeyService` (PF 4): the subject is the customer
 * account, whose key `identity` created with the account; `customers` never calls `createKey`.
 * Destroying the account's key (erasure) makes every address of the account unreadable.
 */
export class SubjectKeyAddressCipher implements AddressCipher {
  constructor(private readonly keys: SubjectKeyService) {}

  seal(market: MarketContext, accountId: Id<'Account'>, content: AddressContent) {
    return this.keys.encrypt(market, accountId, ADDRESS_CONTENT_LABEL, addressToJson(content));
  }

  async open(market: MarketContext, accountId: Id<'Account'>, sealed: string) {
    const opened = await this.keys.decrypt(market, accountId, ADDRESS_CONTENT_LABEL, sealed);
    return opened.ok ? ok(addressFromJson(opened.value)) : err(opened.error);
  }
}
