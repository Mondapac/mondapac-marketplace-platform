import type { RegisterMismatch } from './register-check';

/**
 * The comparison of the register's values with the draft (sellers design 7.7 "Comparison"). A
 * mismatch is a flag for the reviewer and blocks nothing by itself (brief s5); a value that is
 * missing on either side is "not compared", never a mismatch. Pure: the legal suffix list comes
 * from the caller (Market configuration), so this file knows no Market and no register.
 */

/** What the register told about the business: each value is null when it did not say. */
export interface RegisterValues {
  readonly businessName: string | null;
  readonly registeredForIndirectTax: boolean | null;
  readonly postcode: string | null;
}

/** What the draft says, null where the seller has not entered it. */
export interface DraftValues {
  readonly businessName: string | null;
  readonly registeredForIndirectTax: boolean | null;
  readonly postcode: string | null;
}

// Apostrophes join the letters around them ("O'Brien's" is "obriens"); every other punctuation
// mark or symbol separates words.
const APOSTROPHES = /['‘’ʼ]/gu;
const SEPARATORS = /[\p{P}\p{S}\s]+/gu;

function normalised(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(SEPARATORS, ' ')
    .trim();
}

/**
 * A business name after the fixed normalisation: Unicode compatibility form, lower case,
 * punctuation removed, spacing collapsed, and one trailing legal suffix of the Market's list
 * dropped (the suffixes are normalised the same way; the longest is tried first). A name that is
 * nothing but a suffix is kept whole.
 */
export function normalisedBusinessName(text: string, legalSuffixes: readonly string[]): string {
  const name = normalised(text);
  const suffixes = legalSuffixes
    .map(normalised)
    .filter((suffix) => suffix !== '')
    .sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (name.endsWith(` ${suffix}`)) return name.slice(0, name.length - suffix.length - 1).trim();
  }
  return name;
}

const postcodeKey = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

/**
 * The flags for the reviewer, in the order of {@link RegisterMismatch}'s list: business name
 * (after normalisation), indirect-tax registration (the seller's answer against the register's)
 * and postcode (the registered address's when the draft has one, otherwise the operating one; the
 * caller chooses).
 */
export function compareWithRegister(
  register: RegisterValues,
  draft: DraftValues,
  legalSuffixes: readonly string[],
): readonly RegisterMismatch[] {
  const flags: RegisterMismatch[] = [];
  if (register.businessName !== null && draft.businessName !== null) {
    const theirs = normalisedBusinessName(register.businessName, legalSuffixes);
    const ours = normalisedBusinessName(draft.businessName, legalSuffixes);
    if (theirs !== '' && ours !== '' && theirs !== ours) flags.push('business-name');
  }
  if (
    register.registeredForIndirectTax !== null &&
    draft.registeredForIndirectTax !== null &&
    register.registeredForIndirectTax !== draft.registeredForIndirectTax
  ) {
    flags.push('indirect-tax-registration');
  }
  if (register.postcode !== null && draft.postcode !== null) {
    const theirs = postcodeKey(register.postcode);
    const ours = postcodeKey(draft.postcode);
    if (theirs !== '' && ours !== '' && theirs !== ours) flags.push('postcode');
  }
  return flags;
}
