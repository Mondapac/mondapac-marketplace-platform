import { err, ok, type Result } from '@mondapac/shared-kernel';

/**
 * A sign-in email address (identity design 2.1 and 11.2; data design 3.3): as typed (trimmed),
 * and normalised, which is the uniqueness and lookup value per Market and population.
 * Normalised means trimmed, NFC and lower-cased; no provider-specific rewriting.
 */
export interface EmailAddress {
  readonly typed: string;
  readonly normalized: string;
}

export type EmailAddressInvalid = { readonly code: 'email.invalid' };

/** Data design 3.3: 3 to 254 characters. */
const MAX_LENGTH = 254;
/** One `@`, something before and after it, no whitespace. */
const SHAPE = /^[^\s@]+@[^\s@]+$/u;
/** C0 and C1 controls and the bidi formatting characters (HF13; data design 3.3). */
const FORBIDDEN = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** Parses an address from input. Only the format is checked; delivery proves the mailbox. */
export function parseEmailAddress(raw: unknown): Result<EmailAddress, EmailAddressInvalid> {
  if (typeof raw !== 'string') return err({ code: 'email.invalid' });
  const typed = raw.trim();
  if (FORBIDDEN.test(typed) || !SHAPE.test(typed)) return err({ code: 'email.invalid' });
  const normalized = typed.normalize('NFC').toLowerCase();
  for (const value of [typed, normalized]) {
    if (value.length < 3 || value.length > MAX_LENGTH) return err({ code: 'email.invalid' });
  }
  return ok({ typed, normalized });
}
