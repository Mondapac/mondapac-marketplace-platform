import { err, ok, parsePlainText, type PlainText, type Result } from '@mondapac/shared-kernel';

/**
 * The single-line text fields of the seller's draft (sellers design 6.3, 14.3 Q-M11; identity
 * rule HF13): kept as typed after trimming and NFC; no control (line feeds included), bidi,
 * format or default-ignorable character; at least one letter or digit, so a value of only
 * whitespace or invisible characters is refused.
 */
export type TextInvalid = 'length' | 'characters';

/** Q-M11 plaintext limits, in code points after NFC. */
export const BUSINESS_NAME_MAX_LENGTH = 200;
export const PHONE_MAX_LENGTH = 32;
export const CONTACT_EMAIL_MAX_LENGTH = 254;
/** The most a typed phone may carry before spaces and punctuation are removed. */
const PHONE_INPUT_MAX_LENGTH = 64;

const CONTROL = /\p{Cc}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** A single-line value of 1 to `maxLength` code points, after trim and NFC. */
export function parseLine(raw: unknown, maxLength: number): Result<PlainText, TextInvalid> {
  if (typeof raw !== 'string') return err('characters');
  const value = raw.trim().normalize('NFC');
  const length = [...value].length;
  if (length < 1 || length > maxLength) return err('length');
  const text = parsePlainText(value);
  if (!text.ok || CONTROL.test(value) || !LETTER_OR_DIGIT.test(value)) return err('characters');
  return ok(text.value);
}

/** The legal name of the business (draft, General group). */
export type BusinessName = PlainText & { readonly __businessName: true };

export function parseBusinessName(raw: unknown): Result<BusinessName, TextInvalid> {
  const line = parseLine(raw, BUSINESS_NAME_MAX_LENGTH);
  return line.ok ? ok(line.value as BusinessName) : line;
}

/** A phone number, normalised to an optional leading `+` and digits. */
export type Phone = string & { readonly __phone: true };

export type PhoneInvalid = TextInvalid | 'format';

/**
 * A phone number (SEL-11; Q-M11: at most 32 characters after normalisation). Spaces, hyphens,
 * dots and brackets are removed; what remains is an optional `+` and 4 to 20 digits.
 *
 * Interim, Market-neutral rule: Q-M11 wants the pattern "from the Market", and the Market file
 * has no phone section yet (a shared-file change to `market-config.ts`). Until it lands this
 * shape is checked in every Market; the Market pattern will narrow it, never widen it.
 */
export function parsePhone(raw: unknown): Result<Phone, PhoneInvalid> {
  if (typeof raw !== 'string') return err('characters');
  const typed = raw.trim();
  if (typed.length === 0 || typed.length > PHONE_INPUT_MAX_LENGTH) return err('length');
  if (!parsePlainText(typed).ok || CONTROL.test(typed)) return err('characters');
  const normalised = typed.replace(/[\s().-]/gu, '');
  if (normalised.length > PHONE_MAX_LENGTH) return err('length');
  if (!/^\+?[0-9]{4,20}$/u.test(normalised)) return err('format');
  return ok(normalised as Phone);
}

/** The optional contact email (never the sign-in address; sellers design 10, 14.4 Q-M19). */
export type ContactEmail = string & { readonly __contactEmail: true };

export type ContactEmailInvalid = TextInvalid | 'format';

/**
 * A contact email, kept as typed after trimming: at most 254 characters, one `@`, a local part
 * of 1 to 64 characters and a domain with a dot, no whitespace and no hidden character. It is
 * never mailed by this slice; deliverability is not checked.
 */
export function parseContactEmail(raw: unknown): Result<ContactEmail, ContactEmailInvalid> {
  if (typeof raw !== 'string') return err('characters');
  const value = raw.trim().normalize('NFC');
  if (value.length === 0 || [...value].length > CONTACT_EMAIL_MAX_LENGTH) return err('length');
  if (!parsePlainText(value).ok || CONTROL.test(value)) return err('characters');
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@.]+$/u.test(value)) return err('format');
  return ok(value as ContactEmail);
}
