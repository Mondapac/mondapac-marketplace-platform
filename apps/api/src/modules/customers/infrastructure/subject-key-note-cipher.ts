import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import { err } from '@mondapac/shared-kernel';
import {
  SubjectKeyMissingError,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
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

  async seal(market: MarketContext, accountId: Id<'Account'>, body: string) {
    try {
      return await this.keys.encrypt(market, accountId, CUSTOMER_NOTE_LABEL, body);
    } catch (error) {
      // No key in this Market (never a customer here): the same answer as an erased account, so
      // the caller answers not-found and nothing tells which ids hold a key.
      if (error instanceof SubjectKeyMissingError)
        return err({ code: 'subject-key.destroyed' } as const);
      throw error;
    }
  }

  open(market: MarketContext, accountId: Id<'Account'>, sealed: string) {
    return this.keys.decrypt(market, accountId, CUSTOMER_NOTE_LABEL, sealed);
  }
}
