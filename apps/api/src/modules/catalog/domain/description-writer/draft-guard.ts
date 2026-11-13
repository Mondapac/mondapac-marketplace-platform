/**
 * The server check on a model's description draft (AIS-03; ADR-0019 R1, R9 and R13; catalog design
 * 13.1). Deterministic and fail-closed: a sentence that matches is dropped whole, even when the
 * match might be harmless. The model is told the same rules, so a dropped sentence is rare; the
 * modal says how many were left out and why ("certification" or "other"). The Market's claim
 * vocabulary (the claim-text matcher) runs after this guard in the application layer, on the
 * sentences it kept; a matcher that cannot answer means no draft at all. Whatever the user then
 * saves passes the same server refusal of claim text as typed text (CAT-41).
 */

export type LeftOutReason = 'certification' | 'other';

export interface DraftSentence {
  /** The paragraph the sentence belongs to (0-based). */
  readonly paragraph: number;
  readonly text: string;
}

export interface GuardedDraft {
  readonly sentences: readonly DraftSentence[];
  readonly leftOut: { readonly certification: number; readonly other: number };
}

/** The longest draft the modal takes, in characters (the description field holds more). */
export const MAX_DRAFT_CHARS = 1500;

// Certification and religious-standard words of any type. The CERT-01 types are data and the
// Market's vocabulary is matched later; these are the words a model reaches for.
const CERTIFICATION = new RegExp(
  [
    String.raw`\bh+a+[\s.\-_*]*l+a+[\s.\-_*]*l+\b`,
    String.raw`\bhara+m\b`,
    String.raw`\bk[ao]sh(?:er|rut)\b`,
    String.raw`\bmuslim\w*`,
    String.raw`\bpermitted\b`,
    String.raw`\b(?:pork|alcohol|lard|gelatin)[\s-]*free\b`,
    String.raw`\bvegan\b`,
    String.raw`\bvegetarian\b`,
    String.raw`\borganic\b`,
    String.raw`\bbio\b`,
    String.raw`\bcertif\w*`,
    String.raw`\baccredit\w*`,
    String.raw`\bapproved\b`,
    String.raw`\bzabih\w*`,
    String.raw`\bdhabih\w*`,
    String.raw`\bs[hy]ari'?ah?\b`,
    String.raw`\bislamic\b`,
    String.raw`\bpermissible\b`,
    String.raw`\bforbidden\b`,
    String.raw`\bfair\s*trade\b`,
    'حلال',
    'حرام',
    'ذبح',
    'گواهی',
    'ارگانیک',
    'כשר',
  ].join('|'),
  'iu',
);

// Health, nutrition, allergy and medical wording (R13), and religious rulings.
const HEALTH = new RegExp(
  [
    String.raw`\ballerg\w*`,
    String.raw`\bgluten\w*`,
    String.raw`\blactose\b`,
    String.raw`\b(?:dairy|nut|sugar|fat|egg|soy|wheat)[\s-]*free\b`,
    String.raw`\bdiabet\w*`,
    String.raw`\bcholesterol\b`,
    String.raw`\bimmun\w*`,
    String.raw`\bcures?\b`,
    String.raw`\bheal(?:s|ing|thy|thier|th)?\b`,
    String.raw`\bmedic\w*`,
    String.raw`\bdetox\w*`,
    String.raw`\bweight[\s-]*loss\b`,
    String.raw`\bsuperfood\w*`,
    String.raw`\bnutriti\w*`,
    String.raw`\bvitamin\w*`,
    String.raw`\bdoctor\w*`,
    String.raw`\bclinical\w*`,
    String.raw`\bsafe (?:for|during) (?:pregnan\w*|children|babies|kids)\b`,
  ].join('|'),
  'iu',
);

// Price, stock and delivery: those live on each seller's Offer, never in product content.
const CURRENCY = String.raw`(?:[A-Z]{0,3}\$|€|£|¥|₹|﷼|\b(?:cents?|dollars?|euros?|pounds?|rupees?|ringgit|rials?|riyals?|dirhams?|dinars?)\b)`;
const COMMERCE = new RegExp(
  [
    CURRENCY,
    String.raw`\b(?:price[sd]?|pricing|discount\w*|sale|cheap\w*|bargain\w*|deal|deals)\b`,
    String.raw`\b(?:in|out of) stock\b`,
    String.raw`\bsold out\b`,
    String.raw`\bavailab(?:le|ility)\b`,
    String.raw`\b(?:deliver(?:y|ed|s)?|shipping|ships|dispatch\w*)\b`,
    String.raw`\b(?:buy|order) (?:now|today)\b`,
  ].join('|'),
  'iu',
);

// Letters that look like Latin ones, folded before the certification words are tested.
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

/**
 * NFKC, accents and vowel marks removed ("ḥalāl" -> "halal", Arabic harakat dropped), look-alikes
 * folded, and single letters split by separators joined ("h.a.l.a.l", "ح ل ا ل" -> one word). The
 * letter test uses look-arounds, since `\b` only knows ASCII letters.
 */
function folded(sentence: string): string {
  const normal = sentence
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .normalize('NFC')
    .replace(LOOK_ALIKE, (letter) => LOOK_ALIKES[letter.toLowerCase()] ?? letter);
  return normal.replace(/(?<!\p{L})(?:\p{L}[\s.\-*_·]){2,}\p{L}(?!\p{L})/gu, (run) =>
    run.replace(/[\s.\-*_·]/gu, ''),
  );
}

/** For the certification words only: a capital I, a one or a bar read as l ("haIaI", "ha1al"). */
function certificationFolded(sentence: string): string {
  return folded(sentence).replace(/[I1|]/gu, 'l');
}

// Inert rendering (R9): no markup, links, images, addresses or invisible characters survive.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const TAG = /<[^>]*>/g;
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu;
const SCHEME = /\b(?:javascript|data|vbscript|mailto|tel):\S*/giu;
const EMAIL_LIKE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const BARE_DOMAIN = /\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}\b(?:\/\S*)?/gu;
const MARKUP_CHARACTERS = /[*_`#>|~<{}[\]\\]/g;
const LIST_MARKER = /^\s*(?:[-+•]|\d+[.)])\s+/gmu;
const INVISIBLE =
  /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
// Runs of eight or more digits (with spaces or dashes): phone numbers and other contact details.
const LONG_DIGITS = /\+?\p{Nd}[\p{Nd}\s()-]{6,}\p{Nd}/gu;

function inert(text: string): string {
  // Invisible characters go first (per row, since line breaks are control characters), so none
  // can split a link, an address or a phone number past the filters below (Hassan M1).
  return text
    .replace(/\r\n?/g, '\n')
    .normalize('NFKC')
    .split('\n')
    .map((row) => row.replace(INVISIBLE, ''))
    .join('\n')
    .replace(MARKDOWN_IMAGE, ' ')
    .replace(MARKDOWN_LINK, '$1')
    .replace(TAG, ' ')
    .replace(SCHEME, ' ')
    .replace(URL_LIKE, ' ')
    .replace(EMAIL_LIKE, ' ')
    .replace(BARE_DOMAIN, ' ')
    .replace(LONG_DIGITS, ' ')
    .replace(LIST_MARKER, '')
    .replace(MARKUP_CHARACTERS, ' ');
}

// A sentence ends at . ! ? or ؟ followed by white space ("2.5 kg" stays whole).
const SENTENCE_BREAK = /(?<=[.!?؟])\s+/u;
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;

// Quantity words a model may spell out ("two hundred grams"). "One" is left out: it is mostly not
// a quantity ("one of the best").
const NUMBER_WORD =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|dozens?)\b/giu;

/** Whether every number in the sentence, in digits or in words, appears in the facts given. */
function numbersAreGiven(sentence: string, facts: string): boolean {
  const normalFacts = facts.normalize('NFKC');
  const known = new Set(normalFacts.match(NUMBER) ?? []);
  for (const number of sentence.normalize('NFKC').match(NUMBER) ?? []) {
    if (!known.has(number)) return false;
  }
  const knownWords = new Set((normalFacts.match(NUMBER_WORD) ?? []).map((w) => w.toLowerCase()));
  for (const word of sentence.match(NUMBER_WORD) ?? []) {
    if (!knownWords.has(word.toLowerCase())) return false;
  }
  return true;
}

/** Why a sentence must go, or null when it may stay. */
export function sentenceVerdict(sentence: string, facts: string): LeftOutReason | null {
  const plain = folded(sentence);
  if (CERTIFICATION.test(plain) || CERTIFICATION.test(certificationFolded(sentence))) {
    return 'certification';
  }
  if (HEALTH.test(plain)) return 'other';
  if (COMMERCE.test(plain) || COMMERCE.test(sentence)) return 'other';
  if (!numbersAreGiven(plain, facts)) return 'other';
  return null;
}

/**
 * Makes the model's text inert, splits it into paragraphs and sentences, and drops each sentence
 * the rules above refuse. `facts` is every text the writer gave (a number not in it is a fact the
 * model added). The kept text is cut at a sentence once it reaches {@link MAX_DRAFT_CHARS}.
 */
export function guardDraft(text: string, facts: string): GuardedDraft {
  const sentences: DraftSentence[] = [];
  let certification = 0;
  let other = 0;
  let length = 0;
  let paragraph = 0;
  for (const block of inert(text).split(/\n\s*\n+/u)) {
    let kept = false;
    for (const part of block.split(SENTENCE_BREAK)) {
      const sentence = part.replace(/\s+/gu, ' ').trim();
      if (sentence.length === 0 || !/[\p{L}\p{N}]/u.test(sentence)) continue;
      const verdict = sentenceVerdict(sentence, facts);
      if (verdict === 'certification') {
        certification += 1;
        continue;
      }
      if (verdict === 'other') {
        other += 1;
        continue;
      }
      if (length + sentence.length > MAX_DRAFT_CHARS) {
        return { sentences, leftOut: { certification, other } };
      }
      sentences.push({ paragraph, text: sentence });
      length += sentence.length + 1;
      kept = true;
    }
    if (kept) paragraph += 1;
  }
  return { sentences, leftOut: { certification, other } };
}

/** The kept sentences as the field takes them: sentences joined by a space, paragraphs by a blank line. */
export function draftText(sentences: readonly DraftSentence[]): string {
  const paragraphs: string[][] = [];
  for (const sentence of sentences) {
    (paragraphs[sentence.paragraph] ??= []).push(sentence.text);
  }
  return paragraphs
    .filter((row) => row !== undefined && row.length > 0)
    .map((row) => row.join(' '))
    .join('\n\n');
}
