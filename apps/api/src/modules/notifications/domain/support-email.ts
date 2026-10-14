import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

/** The longest address, by RFC 5321 (and the column). */
export const MAX_EMAIL_LENGTH = 254;

// Printable ASCII only, in lower case: letters, digits and "._+-" in the local part, a dotted
// domain of letters, digits and hyphens, and a letters-only last label of two or more. This keeps
// look-alike letters (a Cyrillic "o") out, and keeps "?", "=", "&", "%" and "#" out of the local
// part, so a mailto: link built from the address cannot carry extra parameters. An IDN domain
// must be given in punycode. The database CHECK states the same rule.
const SHAPE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export type SupportEmailInvalid = { readonly code: 'validation.failed'; readonly path: 'email' };

/** A support email address from the wire: trimmed, lower-cased, at most 254 characters. */
export function parseSupportEmail(value: unknown): Result<string, SupportEmailInvalid> {
  if (typeof value !== 'string') return err({ code: 'validation.failed', path: 'email' });
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !SHAPE.test(email)) {
    return err({ code: 'validation.failed', path: 'email' });
  }
  return ok(email);
}
