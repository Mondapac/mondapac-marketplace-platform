import { createHash, randomBytes } from 'node:crypto';
import type { GuestTokens } from '../application/ports/guest-tokens';

/** 32 random bytes as 43 base64url characters, exactly. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export class CryptoGuestTokens implements GuestTokens {
  issue() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashOf(token) };
  }

  hashOf(token: string): string | null {
    return TOKEN_FORMAT.test(token) ? hashOf(token) : null;
  }
}
