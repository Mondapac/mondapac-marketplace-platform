import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { AdminNoteCipher } from '../application/ports/admin-order-notes';

/** The label an admin note's text is bound to (platform subject keys, PF 4 row 3). */
export const ADMIN_NOTE_LABEL = fieldLabel('ordering.admin-order-note.body');

/**
 * {@link AdminNoteCipher} on the platform `SubjectKeyService`: the subject is the order's customer
 * account, whose key `identity` created with the account; `ordering` never calls `createKey`.
 */
export class SubjectKeyAdminNoteCipher implements AdminNoteCipher {
  constructor(private readonly keys: SubjectKeyService) {}

  seal(market: MarketContext, accountId: Id<'Account'>, body: string) {
    return this.keys.encrypt(market, accountId, ADMIN_NOTE_LABEL, body);
  }

  open(market: MarketContext, accountId: Id<'Account'>, sealed: string) {
    return this.keys.decrypt(market, accountId, ADMIN_NOTE_LABEL, sealed);
  }
}
