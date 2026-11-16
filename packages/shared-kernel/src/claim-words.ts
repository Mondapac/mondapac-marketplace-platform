/**
 * The words and the folding every AI text guard shares (ADR-0019 R1, R13): which spellings of a
 * certification, religious-standard or diet claim a model reply must never carry. Pure, with no
 * import (shared kernel, ADR-0008). The assistant's reply guard and its list-line check use it; the catalog draft
 * guard keeps its own copy until it is moved here (follow-up).
 */

// Letters that look like Latin ones, folded before the claim words are tested.
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ӏ: 'l',
  ⅼ: 'l',
  ı: 'i',
  α: 'a',
  ο: 'o',
  ε: 'e',
  κ: 'k',
  ν: 'v',
  ѕ: 's',
  һ: 'h',
  ԁ: 'd',
  ɡ: 'g',
  ᴢ: 'z',
  ʜ: 'h',
};
const LOOK_ALIKE = new RegExp(`[${Object.keys(LOOK_ALIKES).join('')}]`, 'giu');
// Default-ignorable characters (combining grapheme joiner, variation selectors, soft hyphen ...)
// draw nothing: they are dropped before the words are tested, but the Persian ZWNJ stays.
const IGNORABLE = /(?!‌)\p{DI}/gu;
// Single letters split by separators ("h.a.l.a.l", "ح ل ا ل"): joined into one word.
const SPELLED_OUT_RUN = /(?<!\p{L})(?:\p{L}[\s.\-*_·]){2,}\p{L}(?!\p{L})/gu;

/**
 * NFKC, accents and vowel marks removed ("ḥalāl" is "halal"; Arabic harakat dropped), invisible
 * characters dropped, look-alikes folded, spelled-out words joined.
 */
export function foldForClaims(text: string): string {
  return text
    .normalize('NFKC')
    .replace(IGNORABLE, '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .normalize('NFC')
    .replace(LOOK_ALIKE, (letter) => LOOK_ALIKES[letter.toLowerCase()] ?? letter)
    .replace(SPELLED_OUT_RUN, (run) => run.replace(/[\s.\-*_·]/gu, ''));
}

/**
 * Whether a text carries a claim word, also when a capital I, a one or a bar stands for an l
 * ("haIaI", "ha1al"); both readings are tested, so "Islamic" still counts.
 */
export function hasClaimWord(text: string): boolean {
  const folded = foldForClaims(text);
  return CLAIM_WORDS.test(folded) || CLAIM_WORDS.test(folded.replace(/[I1|]/gu, 'l'));
}

/** Certification, religious-standard and diet words of any type (the letter tests use `\b` on ASCII only). */
export const CLAIM_WORDS = new RegExp(
  [
    String.raw`\bh+e*a+l+a+l+\b`,
    String.raw`\bh+e+l+a+l+\b`,
    String.raw`\bhara+m\b`,
    String.raw`\bk[ao]sh(?:er|rut)\b`,
    String.raw`\bmuslim\w*`,
    String.raw`\bpermitted\b`,
    String.raw`\bpermissible\b`,
    String.raw`\bforbidden\b`,
    String.raw`\b(?:pork|alcohol|lard|gelatin)[\s-]*free\b`,
    String.raw`\bvegan\b`,
    String.raw`\bvegetarian\b`,
    String.raw`\b(?:gluten|lactose|dairy|nut)[\s-]*free\b`,
    String.raw`\borganic\b`,
    String.raw`\bbio\b`,
    String.raw`\bbiologi\w*`,
    String.raw`\böko\w*`,
    String.raw`\bcertif\w*`,
    String.raw`\baccredit\w*`,
    String.raw`\bapproved\b`,
    String.raw`\bz[ae]+b[ie]*h+a+h?\b`,
    String.raw`\bzabih\w*`,
    String.raw`\bdhabih\w*`,
    String.raw`\bs[hy]ari'?ah?\b`,
    String.raw`\bislamic\b`,
    String.raw`\bglatt\b`,
    String.raw`\bparve\b`,
    String.raw`\bfair\s*trade\b`,
    String.raw`\bnon[\s-]*gmo\b`,
    'حلال',
    'حرام',
    'ذبح',
    'ذبیحه',
    'گواهی',
    'ارگانیک',
    'اورگانیک',
    'شرعی',
    'شریعت',
    'کوشر',
    'گیاهخوار',
    'باگلوتن|بدون گلوتن',
    'כשר',
    // Cyrillic х and а fold to Latin x and a before the test.
    'xaляль',
    'xaлaл',
  ].join('|'),
  'iu',
);

/** The same words without word boundaries, for a text reduced to its letters. */
export const CLAIM_WORDS_IN_LETTERS =
  /halal|hallal|helal|kosher|kasher|vegan|vegetarian|organic|certif|zabih|zabeeh|dhabih|sharia|shariah|islamic|حلال|حرام|ذبح|ذبیحه|گواهی|ارگانیک|اورگانیک|شرعی|کوشر|כשר|xaляль|xaлaл/iu;
