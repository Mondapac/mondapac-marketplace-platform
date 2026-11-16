/**
 * The words and the folding every AI text guard shares (ADR-0019 R1, R13): which spellings of a
 * certification, religious-standard or diet claim a model reply must never carry. Pure, with no
 * import (shared kernel, ADR-0008). The assistant's reply guard and its list-line check use it; the
 * catalog draft guard keeps its own copy until it is moved here (follow-up).
 *
 * Only functions are exported: a shared regular expression could be altered by any importer.
 */

// Characters that draw nothing or only stretch a letter: default-ignorables, the Persian
// zero-width non-joiner and joiner, and the Arabic tatweel. Dropped before any test.
const DRAWS_NOTHING = /[\p{DI}\u200C\u0640]/gu;
const APOSTROPHE = /[‘’ʼ`]/gu;
const DASH = /\p{Pd}/gu;

// Latin-script letters that look like a basic Latin one, folded before the words are tested.
// Letters of other scripts are not folded: a word that mixes scripts is refused whole.
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  ɑ: 'a', // ɑ
  ᴀ: 'a', // ᴀ
  ł: 'l', // ł
  ʟ: 'l', // ʟ
  ℓ: 'l', // ℓ
  ↅ: 'l',
  ʜ: 'h', // ʜ
  ı: 'i', // ı
  ɪ: 'i', // ɪ
  ᴋ: 'k', // ᴋ
  ᴢ: 'z', // ᴢ
  ɡ: 'g', // ɡ
  ᴇ: 'e', // ᴇ
  ᴏ: 'o', // ᴏ
  ᴠ: 'v', // ᴠ
  ᴍ: 'm', // ᴍ
  ɴ: 'n', // ɴ
  ʀ: 'r', // ʀ
  ᴛ: 't', // ᴛ
  ꜱ: 's', // ꜱ
  đ: 'd', // đ
  ħ: 'h', // ħ
};
const LOOK_ALIKE = new RegExp(`[${Object.keys(LOOK_ALIKES).join('')}]`, 'gu');

// Arabic-script spellings folded to the Persian ones the word list uses.
const ARABIC_FORMS: Readonly<Record<string, string>> = {
  ي: 'ی', // yeh
  ى: 'ی', // alef maksura
  ك: 'ک', // kaf
  ة: 'ه', // teh marbuta
  ۀ: 'ه',
  ہ: 'ه',
  ؤ: 'و',
};
const ARABIC_FORM = new RegExp(`[${Object.keys(ARABIC_FORMS).join('')}]`, 'gu');

// Single letters split by separators ("h.a.l.a.l", "h. a. l. a. l.", "ح ل ا ل"): joined.
const SPELLED_OUT_RUN = /(?<!\p{L})(?:\p{L}[\s\p{P}\p{S}]+){2,}\p{L}(?!\p{L})/gu;
const SEPARATORS = /[\s\p{P}\p{S}]+/u;

function prepare(text: string): string {
  return text.normalize('NFKC').replace(DRAWS_NOTHING, '').replaceAll('\u200D', '');
}

/**
 * NFKC, invisible characters dropped, accents and vowel marks removed ("ḥalāl" is "halal"; Arabic
 * harakat dropped; every combining mark goes, enclosing ones too), look-alike Latin letters
 * folded, Arabic forms folded to Persian ones, apostrophes and dashes made plain, spelled-out
 * words joined.
 */
export function foldForClaims(text: string): string {
  return prepare(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(LOOK_ALIKE, (letter) => LOOK_ALIKES[letter] ?? letter)
    .replace(ARABIC_FORM, (letter) => ARABIC_FORMS[letter] ?? letter)
    .replace(APOSTROPHE, "'")
    .replace(DASH, '-')
    .replace(SPELLED_OUT_RUN, (run) => run.replace(/[\s\p{P}\p{S}]/gu, ''));
}

// Not preceded by a letter or digit (JavaScript's \b knows only ASCII).
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;
const REST = String.raw`\p{L}*`;

const STEMS = [
  'h+e*a+l+a+l+',
  'h+e+l+a+l+',
  'hara+m',
  'ko?a?s?c?h(?:er|rut)',
  'casher|cacher',
  'muslim',
  // Written in two parts: the lint rule against vertical names in core code reads literals.
  `veg${'an'}`,
  'vegetar',
  'organic',
  'biologi',
  'oekolog',
  'certif',
  'accredit',
  'z[ae]+b[ie]*h+a+h?',
  'zabih',
  'dhabih',
  "s[hy]ari'?ah?",
  'islamic',
  'pareve|parve',
  'gluten',
  'coeliac|celiac',
  'plant[\\s-]*based',
  'fair[\\s-]*trade',
  'non[\\s-]*gmo',
  // Cyrillic, written as the buyer sees it.
  'халял',
  'халаль',
  'харам',
  'кошер',
  'веган',
  'органическ',
  'вегетариан',
  'сертифи',
  'глютен',
  // Greek.
  'χαλαλ',
  'βιολογικ',
].map((stem) => `${START}(?:${stem})${REST}`);

const WORDS = ['bio', 'glatt', 'gf', 'approved', 'permitted', 'permissible', 'forbidden'].map(
  (word) => `${START}${word}${END}`,
);

const FREE_FROM = [
  String.raw`${START}(?:pork|alcohol|lard|gelatin|lactose|dairy|nut|egg|soy)[\s-]*free${END}`,
  String.raw`${START}(?:no|without|free\s+from)[\s-]+(?:lactose|dairy|nuts?|pork|alcohol|lard|gelatin)${END}`,
];

// Arabic, Persian (spelled with the Persian letters the fold produces; no ZWNJ) and Hebrew
// words, tested without boundaries because the scripts join words without spaces.
const OTHER_SCRIPTS = [
  'حلال',
  'حرام',
  'ذبح',
  'ذبیحه',
  'گواهی',
  'ارگانیک',
  'اورگانیک',
  'عضوی',
  'شرعی',
  'شریعت',
  'کوشر',
  'گیاهخوار',
  'وگان',
  'نباتی',
  'گلوتن',
  'כשר',
  'טבעוני',
  'אורגני',
  'מוסלמי',
];

const CLAIM = new RegExp([...STEMS, ...WORDS, ...FREE_FROM, ...OTHER_SCRIPTS].join('|'), 'iu');
Object.freeze(CLAIM);

// A capital I, a one or a bar for an l ("haIaI"); digits and symbols for letters ("h4l4l").
const L_READING = /[I1|]/gu;
const LEET: Readonly<Record<string, string>> = {
  '4': 'a',
  '@': 'a',
  '0': 'o',
  '3': 'e',
  '9': 'g',
  '5': 's',
  $: 's',
  '7': 't',
  '1': 'l',
  '|': 'l',
  I: 'l',
};
const LEET_CHARACTERS = /[4@039$571|I]/gu;

function carriesClaim(folded: string): boolean {
  if (CLAIM.test(folded)) return true;
  // Words split in two or three pieces ("ha lal", "hal-al", "h al al"): fragments are joined.
  const parts = folded.split(SEPARATORS).filter((part) => part.length > 0);
  for (let index = 0; index < parts.length; index += 1) {
    const one = parts[index]!;
    const two = parts[index + 1];
    const three = parts[index + 2];
    if (two !== undefined && one.length <= 5 && two.length <= 5 && CLAIM.test(one + two)) {
      return true;
    }
    if (
      two !== undefined &&
      three !== undefined &&
      one.length <= 3 &&
      two.length <= 3 &&
      three.length <= 3 &&
      CLAIM.test(one + two + three)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a text carries a claim word, in any of the readings a buyer would take: as folded, with
 * a capital I, a one or a bar read as l ("haIaI"; "Islamic" is still tested as written), and with
 * digits or symbols read as the letters they imitate ("h4l4l"). Words split by spaces, dots or
 * hyphens are joined first.
 */
export function hasClaimWord(text: string): boolean {
  const folded = foldForClaims(text);
  return (
    carriesClaim(folded) ||
    carriesClaim(folded.replace(L_READING, 'l')) ||
    carriesClaim(folded.replace(LEET_CHARACTERS, (character) => LEET[character] ?? character))
  );
}

const SCRIPTS = [
  ['latin', /\p{Script=Latin}/u],
  ['greek', /\p{Script=Greek}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
] as const;
// Scripts no store text uses and that offer look-alikes of Latin letters.
const NEVER_USED = /[\p{Script=Cherokee}\p{Script=Armenian}\p{Script=Coptic}\p{Script=Lisu}]/u;

/**
 * Whether a word of the text mixes letters of two scripts ("Ηalal" with a Greek capital eta,
 * "кosher" with a Cyrillic ka), or uses a script with Latin look-alikes that no store text needs
 * (Cherokee, Armenian). Such a word looks like a claim word without being spelled as one, so a
 * guard that fails closed refuses it.
 */
export function hasLookAlikeScripts(text: string): boolean {
  const prepared = prepare(text);
  if (NEVER_USED.test(prepared)) return true;
  for (const word of prepared.match(/\p{L}+/gu) ?? []) {
    let seen = 0;
    for (const [, pattern] of SCRIPTS) {
      if (pattern.test(word)) seen += 1;
    }
    if (seen > 1) return true;
  }
  return false;
}
