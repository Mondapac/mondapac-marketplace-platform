/** What a masked piece of personal data becomes, before it is stored or sent to a model. */
export const MASKED = '[masked]';

// An email address: a local part, an @, a domain with a dot.
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// A run of digits with spaces, dots, dashes, slashes or brackets between them; a leading +.
const NUMBER_RUN = /\+?\p{Nd}(?:[\p{Nd} ().\-/]*\p{Nd})?/gu;
const DIGIT = /\p{Nd}/gu;

/**
 * Masks the personal data a buyer may type (plan section 4; ADR-0019 R5, SEL-15 masking): email
 * addresses, and any run of 8 or more digits, which covers phone numbers and card numbers in any
 * script's digits and any grouping. Shorter numbers (quantities, sizes, prices, postcodes) stay.
 * Applied before a message is stored and before it is sent to a model; never reversed.
 */
export function maskPersonalData(text: string): string {
  return text
    .replace(EMAIL, MASKED)
    .replace(NUMBER_RUN, (run) => ((run.match(DIGIT)?.length ?? 0) >= 8 ? MASKED : run));
}
