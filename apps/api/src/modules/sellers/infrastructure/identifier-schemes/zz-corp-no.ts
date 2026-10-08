import { err, ok, type Result } from '@mondapac/shared-kernel';
import type { IdentifierInvalid, IdentifierRules } from '../../domain/business-identifier';

const SEPARATORS = /[\s\-.]/gu;
const NINE_DIGITS = /^[0-9]{9}$/u;

/** The scheme code of the synthetic test Market (`sellers.businessIdentifier.scheme`). */
export const ZZ_CORP_NO_SCHEME = 'zz-corp-no';

/**
 * A synthetic 9-digit company number with a Luhn check digit (sellers design 4.1: "another length
 * and checksum"), used by the second Market fixture so that no rule passes by accident for one
 * scheme only. Spaces, hyphens and dots are separators. Pure; no I/O.
 */
export const zzCorpNoScheme: IdentifierRules = Object.freeze({
  scheme: ZZ_CORP_NO_SCHEME,

  normalise(text: string): string {
    return text.normalize('NFKC').replace(SEPARATORS, '');
  },

  validate(normalised: string): Result<void, IdentifierInvalid> {
    if (!NINE_DIGITS.test(normalised)) return err('identifier.format');
    let sum = 0;
    // From the right: every second digit is doubled (Luhn).
    [...normalised].reverse().forEach((char, index) => {
      let digit = Number(char);
      if (index % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    });
    return sum % 10 === 0 ? ok(undefined) : err('identifier.checksum');
  },

  /** `123-456-789`. */
  display(normalised: string): string {
    return NINE_DIGITS.test(normalised)
      ? `${normalised.slice(0, 3)}-${normalised.slice(3, 6)}-${normalised.slice(6)}`
      : normalised;
  },
});
