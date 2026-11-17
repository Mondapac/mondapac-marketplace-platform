import { randomInt } from 'node:crypto';
import { CUSTOMER_CODE_ALPHABET } from '../domain/seller-customers';
import { INVITE_TOKEN_LENGTH } from '../domain/seller-invitations';
import type { InviteTokens } from '../application/ports/seller-invitations.repository';

/**
 * {@link InviteTokens} from the operating system's random source: 26 symbols of Crockford base32
 * drawn uniformly with `crypto.randomInt` (130 bits), so a token cannot be guessed.
 */
export class RandomInviteTokens implements InviteTokens {
  next(): string {
    let token = '';
    for (let index = 0; index < INVITE_TOKEN_LENGTH; index += 1) {
      token += CUSTOMER_CODE_ALPHABET[randomInt(CUSTOMER_CODE_ALPHABET.length)];
    }
    return token;
  }
}
