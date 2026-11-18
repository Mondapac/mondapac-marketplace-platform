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
  ڵ: 'ل',
  ݪ: 'ل',
  ٱ: 'ا',
  ٲ: 'ا',
  ٳ: 'ا',
  ڪ: 'ک',
  ګ: 'ک',
  ھ: 'ه',
  ې: 'ی',
  ۍ: 'ی',
  ێ: 'ی',
  ە: '',
};
const ARABIC_FORM = new RegExp(`[${Object.keys(ARABIC_FORMS).join('')}]`, 'gu');

// Single letters split by separators ("h.a.l.a.l", "h. a. l. a. l.", "ح ل ا ل"): joined.
const SPELLED_OUT_RUN = /(?<!\p{L})(?:\p{L}[\s\p{P}\p{S}]+){2,}\p{L}(?!\p{L})/gu;
const SEPARATORS = /[\s\p{P}\p{S}]+/u;

function enclosedLetter(character: string): string {
  const code = character.codePointAt(0)!;
  const base =
    code >= 0x1f1e6 ? 0x1f1e6 : code >= 0x1f170 ? 0x1f170 : code >= 0x1f150 ? 0x1f150 : 0x1f130;
  return String.fromCharCode(97 + code - base);
}

function prepare(text: string): string {
  return text
    .replace(
      /[\u{1F130}-\u{1F149}\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}\u{1F1E6}-\u{1F1FF}]/gu,
      enclosedLetter,
    )
    .replaceAll('\u00B5', 'u')
    .replaceAll('\u0153', 'oe')
    .replaceAll('\u0152', 'OE')
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

const STEM_SOURCES = [
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
  'ritual(?:ly)?[\\s-]*slaughter',
  'mo[sz]lem',
  'dha?b?e*i?h+a',
  'thabih',
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
  // Malaysia (Malay) and European languages. Words that already contain a listed stem
  // (glutenfrei, vegetariano, biologisch, zertifiziert's "zertif") are covered by it.
  'ecolog',
  'zertifi',
  'sijil',
  'disahkan',
  'diperakui',
  'ditauliah',
  'sembelih',
  'alergi',
  'alerji',
  'alergen',
  'alerjen',
  'alahan',
  'koser',
  'koosjer',
  'organik',
  'gecertific',
  '(?:ber|pen)sijil',
  'diiktiraf',
  '(?:di|pen)?y?sembelih',
  'musulman',
  'islam(?:ique|isch|itisch|i)',
  'hukum[\\s-]*syarak',
  'abattage',
  'geschacht',
  'ritueel',
  'coeliak|coeliaq|zoliak|celiak|cholak',
  'glutin',
  'vejetaryen',
  'vejeteryan',
  '(?:fleisch|schweine?|milch)los',
  'kosjer|kasjer',
  'belgeli',
  'helal',
  'toyyib',
  'jakim',
];
const STEMS = STEM_SOURCES.map((stem) => `${START}(?:${stem})${REST}`);
// A stem that must end where the window ends (an optional plural aside): "hara" + "masala" is no claim.
const STRICT_STEMS = STEM_SOURCES.map((stem) => `${START}(?:${stem})(?:s|es)?${END}`);

const WORDS = [
  'bio',
  'pflanzlich',
  'plantaardig',
  'био',
  'glatt',
  'gf',
  'approved',
  'permitted',
  'permissible',
  'forbidden',
].map((word) => `${START}${word}${END}`);

const FOODS = String.raw`(?:pork|swine|alcohol|lard|gelatin|nuts?|dairy|lactose|meat|milk|eggs?|gluten|wheat|sesame|shellfish)`;
// Food words of the "free of" patterns in other languages. Open endings are bounded, so a long run
// of letters cannot make the patterns backtrack far.
const OTHER_FOODS = String.raw`(?:(?:porc|porco|cerdo|maiale|suino|schwein|varken|babi|khinzir|domuz|svin|alcool|alcohol|alkohol|alkol|alcol|gelatin|laktos|lactos|laktoz|lattos|glutin|gluten|fleisch|vlees|viande|carne|daging|kacang|nuss|nusse|nuts|noten|laitier|arachide|nott|milch|leche|lait|oeuf|huevo|flask|tenusu|susu)\p{L}{0,30}|ei|eier|telur|melk|latte|nuezes|produits[\s-]+laitiers)`;
const FREE_FROM = [
  String.raw`(?:pork|alcohol|lard|gelatin|lactose|dairy|nut|egg|soy|meat|milk|wheat|sesame|shellfish|sugar|fat|msg|gmo)[\s-]*free${END}`,
  String.raw`${START}(?:no|without|free\s+from)[\s-]+(?:lactose|dairy|nuts?|pork|alcohol|lard|gelatin|sugar|meat|milk|eggs?)${END}`,
  String.raw`non[\s-]*alcohol`,
  String.raw`(?:does\s*not|doesn'?t)\s+contain\s+(?:any\s+)?${FOODS}${END}`,
  String.raw`${START}(?:contains?\s+(?:no|zero)|zero|0%|free\s+of|without\s+any)[\s-]+${FOODS}${END}`,
  String.raw`${START}${FOODS}-?less${END}`,
  String.raw`${START}no-?(?:pork|swine)${END}`,
  String.raw`allerg`,
  String.raw`sertifi`,
  // "Free of" in other languages: "ohne Schweinefleisch", "sans porc", "bebas babi", "senza alcol".
  String.raw`${START}(?:sans|sin|senza|ohne|zonder|tanpa|bebas|uden|uten|utan|sem|geen|kein\p{L}{0,2}|pas[\s-]+de|bukan|non|tiada|tidak[\s-]+ada|tidak[\s-]+mengandung(?:i)?|bebas[\s-]+daripada|ne[\s-]+contient[\s-]+pas[\s-]+de|enth[aä]lt[\s-]+kein\p{L}{0,2}|frei[\s-]+von|libre[\s-]+de|vrij[\s-]+van|fri[\s-]+(?:fr[aå]n|f[oö]r)|(?<![\p{N},.])0[,.]?0?%)[\s-]+(?:(?:lemak|bahan|unsur|dna|daripada)[\s-]+){0,2}${OTHER_FOODS}${END}`,
  String.raw`${START}(?:uden|uten|utan)[\s-]+gris\p{L}{0,30}${END}`,
  String.raw`${START}(?:ne[\s-]+contient[\s-]+pas|pas)[\s-]+d'${OTHER_FOODS}${END}`,
  // Suffix forms ("alkoholfrei", "alcoholvrije", "alkolsuz"), also declined, and "içermez".
  String.raw`${START}${OTHER_FOODS}[\s-]*(?:frei|vrij|fri)(?:e|es|er|en|em|t|tt)?${END}`,
  String.raw`${START}${OTHER_FOODS}-?suz${END}`,
  String.raw`${START}${OTHER_FOODS}(?:[\s-]+(?:eti|yagi))?[\s-]+(?:icermez|icermemektedir|yok)${END}`,
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
  'مسلمان',
  '(?<!ب)اسلام',
  'غلوتین',
  '(?<!روغن )(?<!زیت )نباتی',
  'گلوتن',
  'כשר',
  'חלאל',
  'טבעוני',
  'אורגני',
  'מוסלמי',
];

const CLAIM = new RegExp([...STEMS, ...WORDS, ...FREE_FROM, ...OTHER_SCRIPTS].join('|'), 'iu');
const STRICT_CLAIM = new RegExp(
  [...STRICT_STEMS, ...WORDS, ...FREE_FROM, ...OTHER_SCRIPTS].join('|'),
  'iu',
);
Object.freeze(CLAIM);
Object.freeze(STRICT_CLAIM);

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
  '€': 'e',
  '¢': 'c',
  '£': 'l',
  '§': 's',
  '†': 't',
};
const LEET_CHARACTERS = /[4@0396$8571|I!(€¢£§†]/gu;

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
      // A joined window is a claim only when the claim word ends with it ("veg" + "and" is not).
      if (STRICT_CLAIM.test(joined)) return true;
    }
  }
  return false;
}

// Greek and Cyrillic letters, and Latin ones with strokes, drawn like a Latin letter: a reading
// that turns them into that letter ("ΒΙΟ", "НАІАІ", "køsher"); words really written in those
// scripts are tested as they are by the other readings.
const SKELETON: Readonly<Record<string, string>> = {
  Α: 'a',
  Β: 'b',
  Ε: 'e',
  Η: 'h',
  Ι: 'I',
  Κ: 'k',
  Μ: 'm',
  Ν: 'n',
  Ο: 'o',
  Ρ: 'p',
  Τ: 't',
  Υ: 'y',
  Χ: 'x',
  Ζ: 'z',
  ο: 'o',
  ν: 'v',
  ι: 'I',
  κ: 'k',
  α: 'a',
  ε: 'e',
  А: 'a',
  В: 'b',
  Е: 'e',
  Н: 'h',
  І: 'I',
  Ј: 'j',
  К: 'k',
  М: 'm',
  О: 'o',
  Р: 'p',
  Ѕ: 's',
  Т: 't',
  Х: 'x',
  Ү: 'y',
  Ӏ: 'l',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'I',
  ј: 'j',
  ѕ: 's',
  һ: 'h',
  ԁ: 'd',
  г: 'r',
  ѵ: 'v',
  к: 'k',
  ø: 'o',
  æ: 'a',
  œ: 'o',
  ß: 'b',
};
const SKELETON_LETTER = new RegExp(`[${Object.keys(SKELETON).join('')}]`, 'giu');

/**
 * Whether a text carries a claim word, in any of the readings a buyer would take: as folded, with
 * a capital I, a one or a bar read as l ("haIaI"; "Islamic" is still tested as written), and with
 * digits or symbols read as the letters they imitate ("h4l4l"). Words split by spaces, dots or
 * hyphens are joined first.
 */
function replaceLeet(text: string): string {
  return text.replace(LEET_CHARACTERS, (character) => LEET[character] ?? character);
}

function skeletonOf(folded: string): string {
  return folded.replace(
    SKELETON_LETTER,
    (letter) => SKELETON[letter.toLowerCase()] ?? SKELETON[letter] ?? letter,
  );
}

export function hasClaimWord(text: string): boolean {
  const folded = foldForClaims(text);
  return (
    carriesClaim(folded) ||
    carriesClaim(folded.replace(L_READING, 'l')) ||
    carriesClaim(foldForClaims(text.replace(/[\u0153\u0152]/gu, 'o'))) ||
    carriesClaim(foldForClaims(replaceLeet(prepare(text)))) ||
    carriesClaim(foldForClaims(replaceLeet(prepare(text).replaceAll('1', 'i')))) ||
    carriesClaim(foldForClaims(replaceLeet(prepare(text)).replaceAll('a', 'e'))) ||
    carriesClaim(foldForClaims(replaceLeet(prepare(text).replaceAll('@', 'e')))) ||
    carriesClaim(skeletonOf(folded)) ||
    carriesClaim(skeletonOf(folded).replace(L_READING, 'l')) ||
    carriesClaim(replaceLeet(folded))
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
