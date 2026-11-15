import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { CustomerNoteCipher } from '../application/ports/customer-notes.repository';

/** The label a note's text is sealed under (platform subject keys, PF 4 row 3). */
export const CUSTOMER_NOTE_LABEL = fieldLabel('customers.customer-note.body');

/**
 * {@link CustomerNoteCipher} on the platform `SubjectKeyService`: the subject is the customer
 * account (its key is identity's, created with the account), so erasing the account makes every
 * note about the customer unreadable.
 */
export class SubjectKeyNoteCipher implements CustomerNoteCipher {
  constructor(private readonly keys: SubjectKeyService) {}

  seal(market: MarketContext, accountId: Id<'Account'>, body: string) {
    return this.keys.encrypt(market, accountId, CUSTOMER_NOTE_LABEL, body);
  }

  open(market: MarketContext, accountId: Id<'Account'>, sealed: string) {
    return this.keys.decrypt(market, accountId, CUSTOMER_NOTE_LABEL, sealed);
  }
}
