import { err, ok, parsePlainText, type PlainText, type Result } from '@mondapac/shared-kernel';
import type { ReservedWords } from './reserved-words';

/** The store name as typed (design 8.1: clear, public once approved) and its search key. */
export interface StoreName {
  readonly name: PlainText;
  /** NFKC, case-folded, inner whitespace collapsed (data design 3.1 `store_name_key`). */
  readonly key: string;
}

export type StoreNameInvalid = {
  readonly code: 'store-name.invalid';
  readonly rule: 'length' | 'characters';
};

/** Q-M11: store name 1 to 100 characters. */
export const STORE_NAME_MAX_LENGTH = 100;

/** Control characters and bidi marks, the class of the CHECK S7 (data design 2). */
const FORBIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/**
 * The search key of a store name: NFKC, lower-cased, runs of whitespace collapsed to one space,
 * trimmed. The database re-checks the shape (`store_name_key` CHECKs) as a backstop.
 */
export function storeNameKey(name: string): string {
  // NFKC again after lower-casing: lower-casing can create a base and mark pair that NFKC
  // composes (`H` + U+0331), and the database CHECK wants a key that is NFKC-stable.
  return name.normalize('NFKC').toLowerCase().normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** NFKC can expand a character a great deal; the key stays well under a btree entry (Hassan L2). */
export const STORE_NAME_KEY_MAX_LENGTH = 400;

/** Letters and digits that look like Latin ones, folded for the claim-word match (UTS #39 spirit). */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ѕ: 's',
  һ: 'h',
  ј: 'j',
  к: 'k',
  м: 'm',
  т: 't',
  н: 'h',
  ԁ: 'd',
  ɡ: 'g',
  ο: 'o',
  α: 'a',
  ε: 'e',
  ν: 'v',
  ρ: 'p',
  ι: 'i',
  κ: 'k',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ɑ: 'a',
  ı: 'i',
};
const DIGIT_LOOK_ALIKES: Readonly<Record<string, string>> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
};

/**
 * The forms a token can take once accents, look-alike letters and look-alike digits are folded.
 * `1` reads as `l` or `i`, so both forms are returned (Hassan M1).
 */
function foldedForms(token: string): readonly string[] {
  const base = token
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  const letters = [...base].map((c) => LOOK_ALIKES[c] ?? DIGIT_LOOK_ALIKES[c] ?? c).join('');
  return [letters.replaceAll('1', 'l'), letters.replaceAll('1', 'i')];
}

/**
 * A store name (design 6.3, Q-M11): kept as typed after trimming; 1 to 100 characters after
 * NFC; no control, bidi or default-ignorable character; not only invisible text. Claim words
 * are not refused here: they are a reviewer flag (`claimWordsIn`).
 */
export function parseStoreName(raw: unknown): Result<StoreName, StoreNameInvalid> {
  if (typeof raw !== 'string') return err({ code: 'store-name.invalid', rule: 'length' });
  const trimmed = raw.trim().normalize('NFC');
  const length = [...trimmed].length;
  if (length < 1 || length > STORE_NAME_MAX_LENGTH) {
    return err({ code: 'store-name.invalid', rule: 'length' });
  }
  const text = parsePlainText(trimmed);
  if (!text.ok || FORBIDDEN.test(trimmed)) {
    return err({ code: 'store-name.invalid', rule: 'characters' });
  }
  // At least one letter or digit: a name of blank-looking characters or bare marks is invisible.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    return err({ code: 'store-name.invalid', rule: 'characters' });
  }
  const key = storeNameKey(trimmed);
  if ([...key].length > STORE_NAME_KEY_MAX_LENGTH) {
    return err({ code: 'store-name.invalid', rule: 'length' });
  }
  return ok({ name: text.value, key });
}

/**
 * The claim words found in a store name: a reviewer flag, never a refusal (3.5). The name is
 * split on anything that is not a letter or digit, and each token is folded (accents, look-alike
 * letters and digits) before it is compared, so `Halal!`, `(Halal)` and `H4LAL` are found.
 */
export function claimWordsIn(name: string, reserved: ReservedWords): readonly string[] {
  const tokens = storeNameKey(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
  const found = new Set<string>();
  for (const token of tokens) {
    for (const form of foldedForms(token)) if (reserved.claimWords.has(form)) found.add(form);
  }
  return [...found];
}
