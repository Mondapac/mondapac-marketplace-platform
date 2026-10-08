// Data of the claim-text matcher (design 4.6). Hassan sets the normalisation and the corpus
// (brief s7, M8): change these tables only with his review and a matching corpus case.

/**
 * Letters mapped before case folding, so a capital I written as a lower-case L (and the reverse)
 * lands on one letter: UTS #39 treats `I`, `l` and `|` as one skeleton character.
 */
export const PRE_FOLD_MAP: Readonly<Record<string, string>> = Object.freeze({
  I: 'l',
  '|': 'l',
  ı: 'i',
  // Capital Greek and Cyrillic letters are mapped before lower-casing: lower-casing first turns
  // Greek Η into η and Ν into ν, which no longer look like h and n (Hassan, PR 132).
  Α: 'a',
  Β: 'b',
  Ε: 'e',
  Ζ: 'z',
  Η: 'h',
  Ι: 'l',
  Κ: 'k',
  Μ: 'm',
  Ν: 'n',
  Ο: 'o',
  Ρ: 'p',
  Τ: 't',
  Υ: 'y',
  Χ: 'x',
  А: 'a',
  В: 'b',
  Е: 'e',
  К: 'k',
  М: 'm',
  Н: 'h',
  О: 'o',
  Р: 'p',
  С: 'c',
  Т: 't',
  У: 'y',
  Х: 'x',
  І: 'l',
  Ј: 'j',
  Ѕ: 's',
});

/**
 * INTERIM confusable skeleton, applied after case folding and mark stripping. This is a curated
 * subset (Cyrillic and Greek look-alikes of Latin letters, Arabic and Persian letter variants,
 * Arabic-Indic digits). It is NOT the full UTS #39 `confusables.txt` table: that file could not
 * be fetched in the build environment, so the generated full table replaces this one as a
 * follow-up (tracked in the slice 2 PR). Until then the second pass and the catalog refusal are
 * the controls; the claim guard stays deterministic defence in depth (ADR-0019 R1).
 */
export const SKELETON_MAP: Readonly<Record<string, string>> = Object.freeze({
  // `i` and `l` share one skeleton letter (the capital I rule in PRE_FOLD_MAP puts capital I on l),
  // so a capitals-only text such as ORGANIC meets the lower-case term.
  i: 'l',
  հ: 'h',
  օ: 'o',
  ɦ: 'h',
  ʋ: 'v',
  σ: 'o',
  ڶ: 'ل',
  ݪ: 'ل',
  // Cyrillic
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'l',
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
  ι: 'l',
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
  ⅰ: 'l',
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
  // Latin small capitals and barred letters
  ʜ: 'h',
  ᴀ: 'a',
  ʟ: 'l',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ɢ: 'g',
  ɪ: 'l',
  ᴋ: 'k',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ʀ: 'r',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ʏ: 'y',
  ᴢ: 'z',
  ł: 'l',
  ø: 'o',
  ħ: 'h',
  đ: 'd',
  η: 'n',
  τ: 't',
  // More Arabic and Persian variants
  ھ: 'ه',
  ہ: 'ه',
  ە: 'ه',
  ۀ: 'ه',
  ڪ: 'ک',
});

/** Start code points of the non-ASCII decimal digit blocks (Unicode 15.1, \p{Nd}); ten each. */
const DIGIT_BLOCK_STARTS: readonly number[] = [
  0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50,
  0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
  0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30,
  0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0,
  0x11950, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2,
  0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950, 0x1fbf0,
];

/** ASCII for a non-ASCII decimal digit or a regional-indicator letter (🇦 to 🇿); else `null`. */
export function numericOrIndicatorToAscii(cp: number): string | null {
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return String.fromCharCode(0x61 + cp - 0x1f1e6);
  if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode(0x61 + cp - 0x1f170);
  for (const start of DIGIT_BLOCK_STARTS) {
    if (cp >= start && cp < start + 10) return String(cp - start);
  }
  return null;
}

/** Second-pass digit and symbol to letter map (M8). Hassan's; extend with a corpus case. */
export const LEET_MAP: Readonly<Record<string, string>> = Object.freeze({
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '9': 'g',
  '6': 'g',
  '8': 'b',
  '2': 'z',
  '!': 'l',
  '#': 'h',
});

/** At most this many texts per call (Hassan: no unbounded work per request). */
export const MAX_TEXTS = 100;

/** A text longer than this is refused by throwing (the facade then fails closed). */
export const MAX_TEXT_LENGTH = 20_000;
