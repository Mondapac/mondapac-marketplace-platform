import { createHmac, randomInt } from 'node:crypto';
import type { BatchCodeCrypto } from '../application/ports/batch-code-crypto';

/** The shortest pepper accepted: the same floor the config schema enforces (32 characters). */
export const MIN_PEPPER_LENGTH = 32;

/**
 * Single-use codes from the operating system's cryptographic random source: every character is
 * drawn with `crypto.randomInt`, which is uniform over the alphabet (no modulo bias). The stored
 * value is HMAC-SHA256 of the normalised code, keyed by a server-side pepper
 * (`PROMOTIONS_CODE_PEPPER`, never stored in the database), so a copy of the table alone cannot be
 * used to test guesses offline. Without a pepper of enough length the adapter is not `available`
 * and the use cases refuse to generate or look up a code (fail closed). Changing the pepper makes
 * every stored hash unmatchable: it is rotated only with a re-issue of the codes.
 */
export class CryptoBatchCodeCrypto implements BatchCodeCrypto {
  readonly available: boolean;

  constructor(private readonly pepper: string | null) {
    this.available = pepper !== null && pepper.length >= MIN_PEPPER_LENGTH;
  }

  generate(alphabet: string, length: number): string {
    let code = '';
    for (let i = 0; i < length; i++) code += alphabet[randomInt(alphabet.length)];
    return code;
  }

  hash(code: string): string {
    if (!this.available || this.pepper === null) {
      throw new Error('batch code pepper is not configured');
    }
    return createHmac('sha256', this.pepper).update(code, 'utf8').digest('hex');
  }
}
