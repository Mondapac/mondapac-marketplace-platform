import { err, ok, type Result } from '@mondapac/shared-kernel';
import type { IdentifierInvalid, IdentifierRules } from '../../domain/business-identifier';

/** Digits only after NFKC: full-width and other compatibility digits become ASCII first. */
const SEPARATORS = /[\s\-.]/gu;
const ELEVEN_DIGITS = /^[0-9]{11}$/u;
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;
const MODULUS = 89;

/**
 * The scheme code, as the Market configuration names it (`sellers.businessIdentifier.scheme`).
 * It is data of this adapter, not a Market: any Market may name it.
 */
export const ABN_SCHEME = 'abn';

/**
 * An 11-digit business number with a weighted checksum (sellers design 4.2; the checksum of the
 * Australian Business Number): subtract 1 from the first digit, multiply the digits by the
 * weights 10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, add them, and the sum must be a multiple of 89.
 * Spaces, hyphens and dots are separators. Pure; no I/O.
 */
export const abnScheme: IdentifierRules = Object.freeze({
  scheme: ABN_SCHEME,

  normalise(text: string): string {
    return text.normalize('NFKC').replace(SEPARATORS, '');
  },

  validate(normalised: string): Result<void, IdentifierInvalid> {
    if (!ELEVEN_DIGITS.test(normalised)) return err('identifier.format');
    const digits = [...normalised].map(Number);
    digits[0] = digits[0]! - 1;
    const sum = digits.reduce((total, digit, index) => total + digit * WEIGHTS[index]!, 0);
    return sum % MODULUS === 0 ? ok(undefined) : err('identifier.checksum');
  },

  /** `51 824 753 556`: two digits, then groups of three. */
  display(normalised: string): string {
    return ELEVEN_DIGITS.test(normalised)
      ? `${normalised.slice(0, 2)} ${normalised.slice(2, 5)} ${normalised.slice(5, 8)} ${normalised.slice(8)}`
      : normalised;
  },
});
