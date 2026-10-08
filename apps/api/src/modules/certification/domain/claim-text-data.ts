// Data of the claim-text matcher (design 4.6). Hassan sets the normalisation and the corpus
// (brief s7, M8): change these tables only with his review and a matching corpus case.

/**
 * Letters mapped before case folding, so a capital I written as a lower-case L (and the reverse)
 * lands on one letter: UTS #39 treats `I`, `l` and `|` as one skeleton character.
 */
export const PRE_FOLD_MAP: Readonly<Record<string, string>> = {
  I: 'l',
  '|': 'l',
  ı: 'i',
};

/**
 * INTERIM confusable skeleton, applied after case folding and mark stripping. This is a curated
 * subset (Cyrillic and Greek look-alikes of Latin letters, Arabic and Persian letter variants,
 * Arabic-Indic digits). It is NOT the full UTS #39 `confusables.txt` table: that file could not
 * be fetched in the build environment, so the generated full table replaces this one as a
 * follow-up (tracked in the slice 2 PR). Until then the second pass and the catalog refusal are
 * the controls; the claim guard stays deterministic defence in depth (ADR-0019 R1).
 */
export const SKELETON_MAP: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  һ: 'h',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ѵ: 'v',
  ӏ: 'l',
  ь: 'b',
  к: 'k',
  м: 'm',
  н: 'h',
  т: 't',
  // Greek
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ο: 'o',
  ρ: 'p',
  ν: 'v',
  υ: 'u',
  χ: 'x',
  ω: 'w',
  // Latin look-alikes that NFKC does not fold
  ɑ: 'a',
  ɡ: 'g',
  ƅ: 'b',
  ǀ: 'l',
  ⅼ: 'l',
  ⅰ: 'i',
  ό: 'o',
  // Arabic and Persian letter variants (one skeleton per visual letter)
  ي: 'ی',
  ى: 'ی',
  ئ: 'ی',
  ك: 'ک',
  ة: 'ه',
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ؤ: 'و',
  // Arabic-Indic and Persian digits
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
};

/** Second-pass digit and symbol to letter map (M8). Hassan's; extend with a corpus case. */
export const LEET_MAP: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

/** A text longer than this is refused by throwing (the facade then fails closed). */
export const MAX_TEXT_LENGTH = 20_000;
