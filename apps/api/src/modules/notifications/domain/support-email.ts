import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

/** The longest address, by RFC 5321 (and the column). */
export const MAX_EMAIL_LENGTH = 254;

// One local part and a dotted domain; no space, control character, second "@" or comma. The
// address is only ever shown to people and mailed to, so this check is deliberately plain.
const SHAPE = /^[^@\s\p{C},;<>()[\]\\"]+@[^@\s\p{C},;<>()[\]\\"]+\.[^@\s\p{C},;<>()[\]\\".]+$/u;

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
