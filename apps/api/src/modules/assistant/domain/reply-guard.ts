import { MASKED, maskPersonalData } from './personal-data';

/**
 * Why the guard removed part of a reply; the storefront shows its own fixed text for each:
 * - `see-cards`: a price, stock, delivery or minimum-order claim. Those are shown only on the
 *   cards the server built (plan section 5, guardrail 1).
 * - `see-certification`: a halal or other certification claim. Only the badge built from
 *   `evaluateClaim` says that (guardrail 2, ADR-0019 R1).
 */
export type GuardNotice = 'see-cards' | 'see-certification';

export interface GuardedReply {
  /** The sentences that passed, in order, as inert plain text. */
  readonly sentences: readonly string[];
  readonly notices: readonly GuardNotice[];
}

// Money: a currency sign or word next to a number, in either order; and any ISO 4217 code next
// to a number, upper case (so "12 pcs" stays), whatever the Market's currency.
const CURRENCY = String.raw`(?:[A-Z]{0,3}\$|€|£|¥|₹|₩|₪|₺|﷼|\b(?:cents?|dollars?|bucks|euros?|pounds?|yen|yuan|rupees?|ringgit|rials?|riyals?|dirhams?|dinars?|lira|won)\b|دلار|تومان|ریال|سنت|یورو|درهم|دینار)`;
const AMOUNT = String.raw`\p{Nd}[\p{Nd},.]*`;
const MONEY = new RegExp(`${CURRENCY}\\s*${AMOUNT}|${AMOUNT}\\s*${CURRENCY}`, 'iu');
const CODES = `(?:${Intl.supportedValuesOf('currency').join('|')})`;
const MONEY_CODE = new RegExp(`\\b${CODES}\\s*${AMOUNT}|${AMOUNT}\\s*${CODES}\\b`, 'u');

// Stock, delivery and minimum-order claims (the words, in the languages a buyer may use).
const LOGISTICS = new RegExp(
  [
    String.raw`\b(?:in|out of) stock\b`,
    String.raw`\bsold out\b`,
    String.raw`\bavailab(?:le|ility)\b`,
    String.raw`\b(?:only|just) \p{Nd}+ (?:left|remaining)\b`,
    String.raw`\b(?:deliver(?:y|ed|s)?|shipping|ships|arriv(?:e|es|al))\b`,
    String.raw`\bminimum order\b`,
    'موجود',
    'تحویل',
    'ارسال',
    'حداقل سفارش',
  ].join('|'),
  'iu',
);

// Certification claims of any type (CERT-01 types are data; these are the words a model uses).
const CERTIFICATION = new RegExp(
  [
    String.raw`\bhala+l\b`,
    String.raw`\bharam\b`,
    String.raw`\bkosher\b`,
    String.raw`\bvegan\b`,
    String.raw`\borganic\b`,
    String.raw`\bcertif(?:ied|icate|ication)s?\b`,
    String.raw`\bzabihah?\b`,
    'حلال',
    'حرام',
    'ذبح',
    'گواهی',
    'ارگانیک',
  ].join('|'),
  'iu',
);

// Letters that look like Latin ones, folded before the certification words are tested (L3).
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
const folded = (sentence: string): string =>
  sentence
    .normalize('NFKC')
    .replace(LOOK_ALIKE, (letter) => LOOK_ALIKES[letter.toLowerCase()] ?? letter);

// Inert rendering (R9): no markup, links or images reach the buyer from a model.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const TAG = /<[^>]*>/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/giu;
const EMAIL_LIKE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const MARKUP_CHARACTERS = /[*_`#>|~]/g;
// A bare domain (an off-platform address without a scheme), with any path (Hassan, M1).
const BARE_DOMAIN = /\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}\b(?:\/\S*)?/gu;
// Controls and format characters, except the Persian zero-width non-joiner and line breaks.
const INVISIBLE = /(?![\n‌])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// A sentence ends at . ! ? or ؟ followed by a space, or at a line break ("$12.50" stays whole).
const SENTENCE_BREAK = /(?<=[.!?؟])\s+|\n+/u;

/** One reply is at most this long once checked; a longer one is cut at a sentence. */
export const MAX_REPLY_CHARACTERS = 1200;

function inert(text: string): string {
  // Phone numbers and other runs of 8 or more digits go too: no off-platform contact (M1).
  return maskPersonalData(text)
    .replaceAll(MASKED, ' ')
    .replace(MARKDOWN_IMAGE, ' ')
    .replace(MARKDOWN_LINK, '$1')
    .replace(TAG, ' ')
    .replace(URL_LIKE, ' ')
    .replace(EMAIL_LIKE, ' ')
    .replace(BARE_DOMAIN, ' ')
    .replace(MARKUP_CHARACTERS, ' ')
    .replace(INVISIBLE, '');
}

/**
 * The server check on a model's reply (plan section 5, guardrails 1 and 2; ADR-0019 R1 and R9).
 * The model is told never to state these, and its tools never give it a price or stock figure,
 * so any sentence that does is dropped whole and replaced by a notice that sends the buyer to the
 * card or the badge. The rest is made inert: markup, links, addresses and invisible characters
 * are removed, so the storefront shows plain text only. Deterministic; fails closed (a sentence
 * that matches is dropped even when the claim might be harmless).
 */
export function guardReply(text: string): GuardedReply {
  const sentences: string[] = [];
  const notices = new Set<GuardNotice>();
  let length = 0;
  for (const part of inert(text).split(SENTENCE_BREAK)) {
    const sentence = part.replace(/\s+/gu, ' ').trim();
    if (sentence.length === 0 || !/[\p{L}\p{N}]/u.test(sentence)) continue;
    if (CERTIFICATION.test(folded(sentence))) {
      notices.add('see-certification');
      continue;
    }
    if (MONEY.test(sentence) || MONEY_CODE.test(sentence) || LOGISTICS.test(sentence)) {
      notices.add('see-cards');
      continue;
    }
    if (length + sentence.length > MAX_REPLY_CHARACTERS) break;
    sentences.push(sentence);
    length += sentence.length + 1;
  }
  return { sentences, notices: [...notices] };
}
