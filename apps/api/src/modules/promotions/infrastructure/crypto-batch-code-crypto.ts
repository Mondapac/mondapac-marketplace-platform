import { createHash, randomInt } from 'node:crypto';
import type { BatchCodeCrypto } from '../application/ports/batch-code-crypto';

/**
 * Single-use codes from the operating system's cryptographic random source: every character is
 * drawn with `crypto.randomInt`, which is uniform over the alphabet (no modulo bias). The hash is
 * SHA-256 over the normalised code; the codes carry at least 60 bits (Market config refuses less),
 * so an unsalted hash cannot be searched.
 */
export class CryptoBatchCodeCrypto implements BatchCodeCrypto {
  generate(alphabet: string, length: number): string {
    let code = '';
    for (let i = 0; i < length; i++) code += alphabet[randomInt(alphabet.length)];
    return code;
  }

  hash(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
  }
}
