import type { SellerSignUpField, SellerSignUpFieldError } from '../storefront/types.ts';

// The seller sign-up form's own checks, run in the browser and again in the server action. They
// mirror identity's rules (display-name.ts, HF13; the Market password rule) so a mistake is shown
// before the request; the API stays the authority.

/** Identity design 2.1: a display name is 1 to 100 code points after trimming. */
const NAME_MAX = 100;
/** C0 and C1 controls and the bidi marks, embeddings, overrides and isolates (HF13). */
const NAME_FORBIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;
/** URL-like text: a scheme, a `www.` host or a dotted host name (HF13). */
const NAME_URL_LIKE = [
  /[a-z][a-z0-9+.-]*:\/\//iu,
  /(?:^|[^\p{L}\p{N}])www\./iu,
  /[\p{L}\p{N}-]{2,}\.[\p{L}\p{N}-]+\.[\p{L}]{2,}/iu,
  /[\p{L}\p{N}-]{2,}\.\p{L}{2,}(?:$|[\s/:?#])/iu,
];
/** RFC 5321's path limit; the API checks the address properly. */
const EMAIL_MAX = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface SellerSignUpInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export type SellerSignUpErrors = Partial<Record<SellerSignUpField, SellerSignUpFieldError>>;

/** The form's fields in order: the first one with an error takes the focus. */
export const SIGN_UP_FIELDS: readonly SellerSignUpField[] = ['name', 'email', 'password'];

/** The name and email as sent: trimmed. The password is sent exactly as typed. */
export function cleanSignUp(input: SellerSignUpInput): SellerSignUpInput {
  return { name: input.name.trim(), email: input.email.trim(), password: input.password };
}

/** Each field's first problem; empty when the form may be sent. */
export function checkSignUp(
  input: SellerSignUpInput,
  password: { readonly min: number; readonly max: number },
): SellerSignUpErrors {
  const { name, email } = cleanSignUp(input);
  const errors: SellerSignUpErrors = {};
  if (name === '') errors.name = 'required';
  else if ([...name].length > NAME_MAX) errors.name = 'name-length';
  else if (NAME_FORBIDDEN.test(name) || NAME_URL_LIKE.some((rule) => rule.test(name)))
    errors.name = 'name-characters';
  if (email === '') errors.email = 'required';
  else if (email.length > EMAIL_MAX || !EMAIL_SHAPE.test(email)) errors.email = 'email-format';
  const length = [...input.password].length;
  if (length === 0) errors.password = 'required';
  else if (length < password.min) errors.password = 'password-short';
  else if (length > password.max) errors.password = 'password-long';
  return errors;
}

/** Whole minutes to wait, at least one. */
export function minutesOf(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}
