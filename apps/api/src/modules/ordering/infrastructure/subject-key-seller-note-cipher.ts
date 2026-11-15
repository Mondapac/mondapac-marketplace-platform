import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { SellerNoteCipher } from '../application/ports/seller-order-notes';

/**
 * The label a seller note's text is bound to (platform subject keys, PF 4 row 3): not the admin
 * notes' label, so an admin note's sealed text never opens as a seller note's.
 */
export const SELLER_NOTE_LABEL = fieldLabel('ordering.seller-order-note.body');

/**
 * {@link SellerNoteCipher} on the platform `SubjectKeyService`: the subject is the order's customer
 * account, whose key `identity` created with the account; `ordering` never calls `createKey`.
 */
export class SubjectKeySellerNoteCipher implements SellerNoteCipher {
  constructor(private readonly keys: SubjectKeyService) {}

  seal(market: MarketContext, accountId: Id<'Account'>, body: string) {
    return this.keys.encrypt(market, accountId, SELLER_NOTE_LABEL, body);
  }

  open(market: MarketContext, accountId: Id<'Account'>, sealed: string) {
    return this.keys.decrypt(market, accountId, SELLER_NOTE_LABEL, sealed);
  }
}
