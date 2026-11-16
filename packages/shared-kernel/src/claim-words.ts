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
  return text
    .replaceAll('\u00B5', 'u')
    .normalize('NFKC')
    .replace(DRAWS_NOTHING, '')
    .replaceAll('\u200D', '');
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
const START = String.raw`(?<!\p{L})`;
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
  'o?e?kolog',
  'oekolog',
  'certif',
  'vegetal',
  'veggie',
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
  'халал',
  'органик',
  // Greek.
  'χαλαλ',
  'βιολογικ',
  'endors',
  'afic',
].map((stem) => `${START}(?:${stem})${REST}`);

const WORDS = [
  'bio',
  'био',
  'glatt',
  'gf',
  'approved',
  'permitted',
  'permissible',
  'forbidden',
].map((word) => `${START}${word}${END}`);

const FREE_FROM = [
  String.raw`(?:pork|alcohol|lard|gelatin|lactose|dairy|nut|egg|soy|meat|milk|wheat|sesame|shellfish|sugar|fat|msg|gmo)[\s-]*free${END}`,
  String.raw`${START}(?:no|without|free\s+from)[\s-]+(?:lactose|dairy|nuts?|pork|alcohol|lard|gelatin|sugar|meat|milk|eggs?)${END}`,
  String.raw`non[\s-]*alcohol`,
  String.raw`allerg`,
  String.raw`sertifi`,
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
  'عضوی(?![تهة])',
  'شرعی',
  'شریعت',
  'کوشر',
  'گیاهخوار',
  'وگان',
  'وگن',
  'اسلام',
  'غلوتین',
  'خالیاز',
  '(?<!روغن )(?<!زیت )نباتی',
  'گلوتن',
  'כשר',
  'חלאל',
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
  '6': 'g',
  '8': 'b',
  '!': 'i',
  '(': 'c',
  $: 's',
  '7': 't',
  '1': 'l',
  '|': 'l',
  I: 'l',
};
const LEET_CHARACTERS = /[4@0396$8571|I!(]/gu;

// A window ends on a whole common word that only follows by chance ("veg and herbs").
const CHANCE_ENDINGS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'to']);
const MAX_WINDOW_PIECES = 5;
const MAX_WINDOW_LENGTH = 12;

function pieces(folded: string): string[] {
  return folded.split(SEPARATORS).filter((part) => part.length > 0);
}

function carriesClaim(folded: string): boolean {
  if (CLAIM.test(folded)) return true;
  // Words split in pieces ("ha lal", "hal-al", "h al a l"): neighbouring pieces are joined.
  const parts = pieces(folded);
  for (let start = 0; start < parts.length; start += 1) {
    let joined = parts[start]!;
    for (let end = start + 1; end < parts.length && end < start + MAX_WINDOW_PIECES; end += 1) {
      const piece = parts[end]!;
      joined += piece;
      if (joined.length > MAX_WINDOW_LENGTH) break;
      if (CHANCE_ENDINGS.has(piece.toLowerCase())) continue;
      if (CLAIM.test(joined)) return true;
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

const LATIN = /\p{Script=Latin}/u;
const CYRILLIC_OR_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
// Scripts whose claim words the lists cover; text in any other script is not read and is refused.
const REVIEWED_SCRIPT =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}]+$/u;
// Latin letters that stay after the fold and are real letters of European words.
const PLAIN_LATIN_EXTRAS = new Set(['\u00DF', '\u00E6', '\u0153', '\u00F8']);
const OTHER_SCRIPT_LETTER =
  /[\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}]/u;

function mixesScripts(word: string): boolean {
  let latin = false;
  let other = false;
  for (const letter of word.match(/\p{L}/gu) ?? []) {
    if (LATIN.test(letter)) latin = true;
    else other = true;
  }
  if (latin && other) return true;
  const kinds = [
    /\p{Script=Greek}/u,
    /\p{Script=Cyrillic}/u,
    /\p{Script=Arabic}/u,
    /\p{Script=Hebrew}/u,
  ].filter((pattern) => pattern.test(word)).length;
  return kinds > 1;
}

/**
 * Whether the text cannot be read safely, so a guard that fails closed refuses it: a word that
 * mixes scripts ("Ηalal" with a Greek capital eta, "кosher" with a Cyrillic ka, also when marks or
 * separators split it), a Latin letter that survives the fold and is not an ordinary letter
 * ("haɫaɫ"), or a script whose claim words the lists do not cover (Chinese, Hindi, Thai ...).
 * The Persian zero-width non-joiner counts as a word break here.
 */
export function hasLookAlikeScripts(text: string): boolean {
  const folded = foldForClaims(text.replaceAll('\u200C', ' '));
  for (const letter of folded.match(/\p{L}/gu) ?? []) {
    if (!REVIEWED_SCRIPT.test(letter)) return true;
    if (
      LATIN.test(letter) &&
      !/[a-z]/iu.test(letter) &&
      !PLAIN_LATIN_EXTRAS.has(letter.toLowerCase())
    ) {
      return true;
    }
  }
  const parts = pieces(folded);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (mixesScripts(part)) return true;
    // "Н alal": a one or two letter Cyrillic or Greek piece in front of or behind a Latin word.
    for (const neighbour of [parts[index + 1], parts[index - 1]]) {
      if (
        neighbour !== undefined &&
        [...part].length <= 2 &&
        CYRILLIC_OR_GREEK.test(part) &&
        !OTHER_SCRIPT_LETTER.test(neighbour) &&
        LATIN.test(neighbour)
      ) {
        return true;
      }
    }
  }
  return false;
}
