// The automatic checks of review text (owner decision N5): pure functions of the text and the
// Market's rules. A hit never refuses a review: the review is `held` for a human, with the signal
// codes below. The text itself is never logged, audited, evented or put in a signal: only these
// codes leave this file.

export const TEXT_SIGNALS = [
  'email-address',
  'markup',
  'phone-number',
  'profanity',
  'repeated-text',
  'street-address',
  'web-address',
] as const;
export type TextSignal = (typeof TEXT_SIGNALS)[number];

/** The Market's side of the checks (Market config `reviews.autoChecks`). */
export interface TextRules {
  /** The Market's profanity list; matched as whole words, case-insensitive. */
  readonly blockedTerms: readonly string[];
  /** This many of one character in a row is spam. */
  readonly repeatedCharRun: number;
  /** A text of at least this many words... */
  readonly repeatedWordMinTokens: number;
  /** ...in which one word makes up at least this share (basis points) is spam. */
  readonly repeatedWordShareBps: number;
}

export interface ReviewText {
  readonly title: string | null;
  readonly body: string | null;
}

// Arabic-Indic and Extended Arabic-Indic digits are not changed by NFKC; fullwidth ones are.
const toAsciiDigits = (text: string): string =>
  text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.codePointAt(0)!;
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });

/** One canonical form to match on: compatibility forms folded, digits ASCII, lower case. */
function canonical(text: string): string {
  return toAsciiDigits(text.normalize('NFKC')).toLowerCase();
}

const MARKUP = /<\s*\/?\s*[a-z!][^>]*>|\bjavascript\s*:|\bdata\s*:\s*text\/html|&#x?[0-9a-f]+;/i;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}/;
// A technical list of common top-level domains; not a Market's. A hit only holds the review.
const TLDS =
  'com|net|org|info|biz|io|co|me|ly|app|dev|xyz|shop|store|online|site|link|click|top|vip|' +
  'au|nz|uk|us|ca|my|sg|jp|cn|ru|de|fr|eu|in|id|ae|sa|ir|tr';
const WEB_ADDRESS = new RegExp(
  `(?:\\bhttps?:\\/\\/|\\bwww\\.|(?<![\\p{L}\\p{N}@.-])[\\p{L}\\p{N}][\\p{L}\\p{N}-]*(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:${TLDS})(?![\\p{L}\\p{N}-]))`,
  'iu',
);
// Digits that may be written with spaces, dots, dashes, brackets or a leading plus.
const PHONE_RUN = /\+?\(?\d(?:[\s().-]{0,2}\d){7,}/;
const STREET_SUFFIX =
  'street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|place|pl|boulevard|blvd|crescent|' +
  'cres|terrace|tce|way|parade|pde|highway|hwy|close|circuit|cct';
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,5}[a-z]?(?:\\s*\\/\\s*\\d{1,5})?\\s+(?:[\\p{L}.'-]+\\s+){1,3}(?:${STREET_SUFFIX})\\b` +
    `|\\b\\d{1,5}\\s*\\/\\s*\\d{1,5}\\s+(?:[\\p{L}.'-]+\\s+){0,3}(?:${STREET_SUFFIX})\\b` +
    '|\\bp\\.?\\s?o\\.?\\s?box\\s*\\d+' +
    '|\\d+\\s*(?:丁目|番地|番)',
  'iu',
);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasBlockedTerm(text: string, terms: readonly string[]): boolean {
  for (const term of terms) {
    const needle = canonical(term).trim();
    if (needle === '') continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u');
    if (pattern.test(text)) return true;
  }
  return false;
}

function isRepeated(text: string, rules: TextRules): boolean {
  const characters = Array.from(text.replace(/\s+/g, ' '));
  let run = 1;
  for (let index = 1; index < characters.length; index += 1) {
    run = characters[index] === characters[index - 1] ? run + 1 : 1;
    if (run >= rules.repeatedCharRun) return true;
  }
  const tokens = text.split(/[^\p{L}\p{N}']+/u).filter((token) => token !== '');
  if (tokens.length < rules.repeatedWordMinTokens) return false;
  const counts = new Map<string, number>();
  let most = 0;
  for (const token of tokens) {
    const next = (counts.get(token) ?? 0) + 1;
    counts.set(token, next);
    if (next > most) most = next;
  }
  return most * 10_000 >= rules.repeatedWordShareBps * tokens.length;
}

/**
 * Every signal the text raises, once each, sorted. The title and the body are checked as one
 * text, so a number split between them is not a way round.
 */
export function checkText(text: ReviewText, rules: TextRules): readonly TextSignal[] {
  const joined = [text.title, text.body].filter((part): part is string => part !== null).join('\n');
  if (joined === '') return [];
  const subject = canonical(joined);
  const found = new Set<TextSignal>();
  if (MARKUP.test(subject)) found.add('markup');
  if (EMAIL.test(subject)) found.add('email-address');
  if (WEB_ADDRESS.test(subject.replace(EMAIL, ' '))) found.add('web-address');
  if (PHONE_RUN.test(subject)) found.add('phone-number');
  if (STREET_ADDRESS.test(subject)) found.add('street-address');
  if (hasBlockedTerm(subject, rules.blockedTerms)) found.add('profanity');
  if (isRepeated(subject, rules)) found.add('repeated-text');
  return [...found].sort();
}
