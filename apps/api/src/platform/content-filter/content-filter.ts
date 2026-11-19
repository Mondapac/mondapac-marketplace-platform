// The content filter (owner decision, 6 Nov 2026): free text that the public reads or hears,
// such as descriptions and the alt text of an image (screen readers read it aloud), is refused
// when it holds a term from the Market's list. Pure functions of the text and the list; the text
// itself is never logged, audited or put in an error: only the field path leaves this file.
// Reviews keep their own check (a hit holds the review for a human); this one refuses.

import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../market-config/market-registry';

// Arabic-Indic (U+0660-0669) and Extended Arabic-Indic (U+06F0-06F9) digits are not changed by NFKC.
const toAsciiDigits = (text: string): string =>
  text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => {
    const code = digit.codePointAt(0)!;
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });

// Arabic letter forms written for Persian ones, and marks that change no letter.
const ARABIC_YEH = /[\u064a\u0649]/g; // ي and ى become ی
const ARABIC_KAF = /\u0643/g; // ك becomes ک
const ARABIC_TEH_MARBUTA = /\u0629/g; // ة becomes ه
// Tatweel, Arabic diacritics (harakat), dagger alif, zero-width (non-)joiners, soft hyphen.
const IGNORABLE = /\u0640|[\u064b-\u065f\u0670]|\u200c|\u200d|\u00ad/g;

/**
 * One canonical form to match on: compatibility forms folded, Persian and Arabic letter variants
 * unified, marks and joiners removed, digits ASCII, lower case.
 */
export function canonicalText(text: string): string {
  return toAsciiDigits(text.normalize('NFKC'))
    .replace(IGNORABLE, '')
    .replace(ARABIC_YEH, '\u06cc')
    .replace(ARABIC_KAF, '\u06a9')
    .replace(ARABIC_TEH_MARBUTA, '\u0647')
    .toLowerCase();
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One alternation per Market list, compiled once (the list is the same array on every call).
const PATTERNS = new WeakMap<readonly string[], RegExp | null>();

function patternOf(terms: readonly string[]): RegExp | null {
  if (PATTERNS.has(terms)) return PATTERNS.get(terms)!;
  const needles = terms
    .map((term) => canonicalText(term).trim().replace(/\s+/g, ' '))
    .filter((needle) => needle !== '');
  const pattern =
    needles.length === 0
      ? null
      : new RegExp(
          `(?<![\\p{L}\\p{N}])(?:${needles.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
          'u',
        );
  PATTERNS.set(terms, pattern);
  return pattern;
}

/** True when the text holds a term of the list as a whole word (or whole phrase). */
export function holdsBlockedTerm(text: string, terms: readonly string[]): boolean {
  const pattern = patternOf(terms);
  if (pattern === null || text === '') return false;
  return pattern.test(canonicalText(text).replace(/\s+/g, ' '));
}

/** The paths of the fields whose text holds a term, in the order given. */
export function blockedFields(
  fields: Readonly<Record<string, string | null | undefined>>,
  terms: readonly string[],
): readonly string[] {
  return Object.entries(fields)
    .filter(([, text]) => typeof text === 'string' && holdsBlockedTerm(text, terms))
    .map(([path]) => path);
}

/** The stable code a refused field carries in a validation answer. */
export const BLOCKED_TERM_CODE = 'blocked-term';

/**
 * The Market's content filter (Market config `contentFilter.blockedTerms`). A Market without the
 * section has an empty list: nothing is refused.
 */
export class ContentFilter {
  constructor(private readonly markets: MarketRegistry) {}

  termsOf(market: MarketContext): readonly string[] {
    return this.markets.get(market.marketId).contentFilter?.blockedTerms ?? [];
  }

  /** True when the text holds a term of the Market's list. */
  isBlocked(market: MarketContext, text: string): boolean {
    return holdsBlockedTerm(text, this.termsOf(market));
  }

  /** The fields (by path) to refuse, as validation problems. Empty when all are clean. */
  problems(
    market: MarketContext,
    fields: Readonly<Record<string, string | null | undefined>>,
  ): readonly { readonly path: string; readonly code: string }[] {
    return blockedFields(fields, this.termsOf(market)).map((path) => ({
      path,
      code: BLOCKED_TERM_CODE,
    }));
  }
}
